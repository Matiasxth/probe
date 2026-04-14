import path from 'path';
import chalk from 'chalk';
import { openDatabase, clearDatabase, setMeta } from '../storage/database.js';
import { parseProject, resolveCallGraph } from '../parser/index.js';
import { analyzeGitHistory } from '../analysis/git-history.js';
import { extractPatterns } from '../analysis/patterns.js';
import { DEFAULT_CONFIG } from '../types.js';

export async function indexCommand(opts: { root: string; git?: boolean; verbose?: boolean }): Promise<void> {
  const root = path.resolve(opts.root);
  const start = Date.now();

  console.log(chalk.cyan('probe') + ' Indexing codebase...');
  console.log(chalk.dim(`  Root: ${root}`));

  const db = openDatabase(root);
  clearDatabase(db);

  const config = DEFAULT_CONFIG;

  // Phase 1: Parse all files
  console.log(chalk.dim('\n  Parsing files...'));
  const { files, symbols, errors } = await parseProject(root, db, config, (p) => {
    if (opts.verbose) {
      process.stdout.write(`\r  [${p.current}/${p.total}] ${p.file.slice(0, 60).padEnd(60)}`);
    }
  });
  if (opts.verbose) process.stdout.write('\r' + ' '.repeat(80) + '\r');

  console.log(`  ${chalk.green('✓')} ${files} files, ${symbols} symbols`);

  if (errors.length > 0 && opts.verbose) {
    console.log(chalk.yellow(`  ${errors.length} parse errors:`));
    for (const err of errors.slice(0, 5)) {
      console.log(chalk.dim(`    ${err}`));
    }
  }

  // Phase 2: Resolve call graph
  console.log(chalk.dim('  Resolving call graph...'));
  const calls = resolveCallGraph(db);
  console.log(`  ${chalk.green('✓')} ${calls} call edges`);

  // Phase 3: Git history
  if (opts.git !== false) {
    console.log(chalk.dim('  Analyzing git history...'));
    const coChanges = await analyzeGitHistory(root, db, config);
    console.log(`  ${chalk.green('✓')} ${coChanges} co-change pairs`);
  }

  // Phase 4: Pattern extraction
  console.log(chalk.dim('  Extracting patterns...'));
  const patterns = extractPatterns(db);
  console.log(`  ${chalk.green('✓')} ${patterns} patterns`);

  // Store metadata
  const duration = Date.now() - start;
  setMeta(db, 'version', '0.1.0');
  setMeta(db, 'indexed_at', new Date().toISOString());
  setMeta(db, 'root', root);
  setMeta(db, 'duration_ms', String(duration));
  setMeta(db, 'file_count', String(files));
  setMeta(db, 'symbol_count', String(symbols));

  db.close();

  console.log(chalk.cyan(`\n  Done in ${(duration / 1000).toFixed(1)}s`));
  console.log(chalk.dim(`  Index: ${root}/.probe/probe.db`));
}
