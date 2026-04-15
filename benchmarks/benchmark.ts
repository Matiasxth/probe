/**
 * Benchmark: probe vs blind exploration (grep+read)
 *
 * For each task, we measure:
 * - WITHOUT probe: how many files would grep return? How many tokens to read them all?
 * - WITH probe: how many tokens in probe response? Did it find the correct files?
 *
 * Ground truth: for each task, we define the "correct" files that an agent needs to find.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const TEMP = os.tmpdir();
import Database from 'better-sqlite3';
import { queryCodebase } from '../src/engine/query.js';
import { analyzeImpact } from '../src/engine/impact.js';
import { openDatabase } from '../src/storage/database.js';

interface Task {
  name: string;
  query: string;
  repo: string;
  groundTruth: string[]; // files that MUST appear in results
  type: 'query' | 'impact';
  impactTarget?: string;
}

interface Result {
  task: string;
  repo: string;

  // Without probe (grep simulation)
  grepMatches: number;
  grepTokensEstimate: number;
  grepFilesRead: number;

  // With probe
  probeResultCount: number;
  probeTokens: number;
  probeTimeMs: number;
  probeFoundCorrect: number;
  probeTotalCorrect: number;
  probePrecision: number; // correct found / total results
  probeRecall: number;    // correct found / total correct

  // Savings
  tokenSavings: number;
  tokenSavingsPercent: number;
}

const AVG_TOKENS_PER_FILE = 2000; // ~2000 tokens per file read
const GREP_OVERHEAD_TOKENS = 500; // grep command + result listing

const TASKS: Task[] = [
  // === Express.js ===
  {
    name: 'Express: find response methods',
    query: 'send json response',
    repo: TEMP + '/express',
    groundTruth: ['lib/response.js'],
    type: 'query',
  },
  {
    name: 'Express: impact of res.send',
    query: 'send',
    repo: TEMP + '/express',
    groundTruth: ['lib/response.js'],
    type: 'impact',
    impactTarget: 'send',
  },
  {
    name: 'Express: how routing works',
    query: 'route handler middleware use',
    repo: TEMP + '/express',
    groundTruth: ['lib/application.js', 'lib/response.js'],
    type: 'query',
  },
  {
    name: 'Express: find error handling',
    query: 'error handler',
    repo: TEMP + '/express',
    groundTruth: ['lib/application.js'],
    type: 'query',
  },

  // === Hono ===
  {
    name: 'Hono: middleware composition',
    query: 'compose middleware dispatch',
    repo: TEMP + '/hono',
    groundTruth: ['src/compose.ts', 'src/hono-base.ts'],
    type: 'query',
  },
  {
    name: 'Hono: impact of compose',
    query: 'compose',
    repo: TEMP + '/hono',
    groundTruth: ['src/compose.ts'],
    type: 'impact',
    impactTarget: 'compose',
  },
  {
    name: 'Hono: router implementation',
    query: 'router trie pattern matching',
    repo: TEMP + '/hono',
    groundTruth: ['src/router/reg-exp-router/trie.ts', 'src/router/reg-exp-router/router.ts'],
    type: 'query',
  },
  {
    name: 'Hono: context and request handling',
    query: 'context request header',
    repo: TEMP + '/hono',
    groundTruth: ['src/context.ts', 'src/request.ts'],
    type: 'query',
  },

  // === FastAPI ===
  {
    name: 'FastAPI: dependency injection',
    query: 'depends dependency injection',
    repo: TEMP + '/fastapi',
    groundTruth: ['fastapi/params.py', 'fastapi/dependencies/utils.py'],
    type: 'query',
  },
  {
    name: 'FastAPI: impact of get_dependant',
    query: 'get_dependant',
    repo: TEMP + '/fastapi',
    groundTruth: ['fastapi/dependencies/utils.py'],
    type: 'impact',
    impactTarget: 'get_dependant',
  },
  {
    name: 'FastAPI: create user endpoint',
    query: 'create user',
    repo: TEMP + '/fastapi',
    groundTruth: ['docs_src/extra_models/tutorial001_py310.py'],
    type: 'query',
  },
  {
    name: 'FastAPI: security authentication',
    query: 'security oauth bearer token',
    repo: TEMP + '/fastapi',
    groundTruth: ['fastapi/params.py', 'fastapi/param_functions.py'],
    type: 'query',
  },
];

function estimateGrepCost(repo: string, keywords: string[], db: Database.Database): { matches: number; filesRead: number; tokens: number } {
  // Use the probe DB to simulate grep — count files containing any keyword in symbol names or file paths
  const totalMatches = new Set<string>();

  for (const kw of keywords) {
    // Files with symbols matching keyword
    const symbolFiles = db.prepare(`
      SELECT DISTINCT f.path FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE s.name LIKE ? OR s.signature LIKE ?
    `).all(`%${kw}%`, `%${kw}%`) as Array<{ path: string }>;
    for (const f of symbolFiles) totalMatches.add(f.path);

    // Files with path matching keyword
    const pathFiles = db.prepare(`SELECT path FROM files WHERE path LIKE ?`).all(`%${kw}%`) as Array<{ path: string }>;
    for (const f of pathFiles) totalMatches.add(f.path);
  }

  const matches = totalMatches.size;
  // Agent reads ~40% of grep results before finding what it needs (the rest are false positives)
  const filesRead = Math.max(Math.ceil(matches * 0.4), 1);
  const tokens = GREP_OVERHEAD_TOKENS + (filesRead * AVG_TOKENS_PER_FILE);

  return { matches, filesRead, tokens };
}

function measureProbe(task: Task, db: Database.Database): {
  resultCount: number;
  tokens: number;
  timeMs: number;
  foundCorrect: string[];
} {
  const start = Date.now();

  let resultText: string;
  let resultFiles: string[];

  if (task.type === 'impact' && task.impactTarget) {
    const impact = analyzeImpact(db, task.impactTarget, 3);
    resultText = JSON.stringify(impact);
    resultFiles = impact
      ? [impact.target.file, ...impact.directDependents.map((d) => d.file), ...impact.tests.map((t) => t.file)]
      : [];
  } else {
    const results = queryCodebase(db, task.query, { limit: 10 });
    resultText = JSON.stringify(results);
    resultFiles = results.map((r) => r.file);
  }

  const timeMs = Date.now() - start;
  const tokens = Math.ceil(resultText.length / 4); // ~4 chars per token

  const foundCorrect = task.groundTruth.filter((gt) =>
    resultFiles.some((rf) => rf.includes(gt) || gt.includes(rf)),
  );

  return { resultCount: resultFiles.length, tokens, timeMs, foundCorrect };
}

async function main() {
  console.log('# probe Benchmark: Agent Exploration Cost\n');
  console.log('Comparing blind exploration (grep+read) vs probe-assisted exploration.\n');

  const results: Result[] = [];

  for (const task of TASKS) {
    const dbPath = path.join(task.repo, '.probe', 'probe.db');
    if (!fs.existsSync(dbPath)) {
      console.log(`⚠ Skipping "${task.name}" — index not found at ${dbPath}`);
      continue;
    }

    const db = openDatabase(task.repo);

    // Measure grep cost
    const keywords = task.query.split(/\s+/).filter((w) => w.length > 2);
    const grep = estimateGrepCost(task.repo, keywords, db);

    // Measure probe cost
    const probe = measureProbe(task, db);
    db.close();

    const tokenSavings = grep.tokens - (probe.tokens + (probe.foundCorrect.length * AVG_TOKENS_PER_FILE));
    // probe tokens + still need to read the correct files found
    const probeTotal = probe.tokens + (probe.foundCorrect.length * AVG_TOKENS_PER_FILE);
    const savingsPercent = Math.round(((grep.tokens - probeTotal) / grep.tokens) * 100);

    const result: Result = {
      task: task.name,
      repo: path.basename(task.repo),
      grepMatches: grep.matches,
      grepTokensEstimate: grep.tokens,
      grepFilesRead: grep.filesRead,
      probeResultCount: probe.resultCount,
      probeTokens: probe.tokens,
      probeTimeMs: probe.timeMs,
      probeFoundCorrect: probe.foundCorrect.length,
      probeTotalCorrect: task.groundTruth.length,
      probePrecision: probe.resultCount > 0 ? Math.round((probe.foundCorrect.length / Math.min(probe.resultCount, task.groundTruth.length)) * 100) : 0,
      probeRecall: Math.round((probe.foundCorrect.length / task.groundTruth.length) * 100),
      tokenSavings,
      tokenSavingsPercent: savingsPercent,
    };

    results.push(result);
  }

  // Print results table
  console.log('| Task | Grep files | Grep tokens | Probe tokens | Probe+read tokens | Recall | Savings |');
  console.log('|------|-----------|-------------|-------------|-------------------|--------|---------|');

  let totalGrepTokens = 0;
  let totalProbeTokens = 0;
  let totalRecall = 0;

  for (const r of results) {
    const probeTotal = r.probeTokens + (r.probeFoundCorrect * AVG_TOKENS_PER_FILE);
    console.log(
      `| ${r.task} | ${r.grepMatches} → ${r.grepFilesRead} read | ${r.grepTokensEstimate.toLocaleString()} | ${r.probeTokens.toLocaleString()} | ${probeTotal.toLocaleString()} | ${r.probeRecall}% | ${r.tokenSavingsPercent}% |`,
    );
    totalGrepTokens += r.grepTokensEstimate;
    totalProbeTokens += probeTotal;
    totalRecall += r.probeRecall;
  }

  console.log();
  console.log('## Summary\n');
  console.log(`- Tasks: ${results.length}`);
  console.log(`- Repos: Express (JS/CJS), Hono (TS/ESM), FastAPI (Python)`);
  console.log(`- Total grep exploration tokens: ${totalGrepTokens.toLocaleString()}`);
  console.log(`- Total probe-assisted tokens: ${totalProbeTokens.toLocaleString()}`);
  console.log(`- **Overall savings: ${Math.round(((totalGrepTokens - totalProbeTokens) / totalGrepTokens) * 100)}%**`);
  console.log(`- Average recall: ${Math.round(totalRecall / results.length)}%`);
  console.log();
  console.log('Methodology:');
  console.log('- "Grep tokens" = grep overhead (500) + estimated file reads (40% of matches × 2000 tokens/file)');
  console.log('- "Probe tokens" = JSON response size / 4 chars per token');
  console.log('- "Probe+read tokens" = probe tokens + reading the correct files probe identified');
  console.log('- "Recall" = % of ground truth files found in probe results');
  console.log('- "Savings" = (grep tokens - probe+read tokens) / grep tokens');
}

main().catch(console.error);
