import type Database from 'better-sqlite3';
import type { ImpactResult, SymbolKind } from '../types.js';
import {
  findSymbolAt,
  findSymbolByName,
  getCallers,
  getCallees,
  getTypeUsers,
  getCoChanges,
  getSymbolsByFile,
} from '../storage/queries.js';

export function analyzeImpact(
  db: Database.Database,
  target: string,
  maxDepth: number = 3,
): ImpactResult | null {
  const { filePath, line, symbolName } = parseTarget(target);

  let targetSymbol;
  if (filePath && line) {
    targetSymbol = findSymbolAt(db, filePath, line);
  } else if (filePath && symbolName) {
    const fileSymbols = getSymbolsByFile(db, filePath);
    targetSymbol = fileSymbols.find((s) => s.name === symbolName);
  } else if (symbolName) {
    const candidates = findSymbolByName(db, symbolName);
    targetSymbol = candidates.find((s) => s.is_exported) ?? candidates[0];
  }

  if (!targetSymbol) return null;

  const result: ImpactResult = {
    target: {
      file: targetSymbol.file_path ?? '',
      symbol: targetSymbol.name,
      kind: targetSymbol.kind as SymbolKind,
      line: targetSymbol.line_start,
      signature: targetSymbol.signature,
    },
    directDependents: [],
    indirectDependents: [],
    dependencies: [],
    coChangeCorrelations: [],
    tests: [],
    blastRadius: { level: 'LOW', signatureBreaks: 0, behaviorAffects: 0, coreFiles: 0, testFiles: 0, score: 0 },
  };

  // === Direct dependents (who calls this? — break if signature changes) ===
  const directCallers = getCallers(db, targetSymbol.id);
  for (const caller of directCallers) {
    result.directDependents.push({
      file: caller.file_path ?? '',
      symbol: caller.name,
      line: caller.call_line || caller.line_start,
      type: 'call',
      risk: computeRisk(caller.file_path ?? '', caller.is_exported === 1, db, caller.id),
    });
  }

  // Type dependents
  const typeUsers = getTypeUsers(db, targetSymbol.id);
  for (const user of typeUsers) {
    if (result.directDependents.some((d) => d.file === user.file_path && d.symbol === user.name)) continue;
    result.directDependents.push({
      file: user.file_path ?? '',
      symbol: user.name,
      line: user.line_start,
      type: 'type',
      risk: computeRisk(user.file_path ?? '', user.is_exported === 1, db, user.id),
    });
  }

  // === Indirect dependents (BFS upward — affected if behavior changes) ===
  if (maxDepth > 1) {
    const visited = new Set<number>([targetSymbol.id]);
    const queue: Array<{ id: number; depth: number }> = [];

    for (const caller of directCallers) {
      if (!visited.has(caller.id)) {
        visited.add(caller.id);
        queue.push({ id: caller.id, depth: 2 });
      }
    }

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth > maxDepth) continue;

      const callers = getCallers(db, id);
      for (const caller of callers) {
        if (visited.has(caller.id)) continue;
        visited.add(caller.id);
        result.indirectDependents.push({
          file: caller.file_path ?? '',
          symbol: caller.name,
          line: caller.line_start,
          depth,
        });
        if (depth < maxDepth) queue.push({ id: caller.id, depth: depth + 1 });
      }
    }
  }

  // === Dependencies (what does this function call? — break if they change) ===
  const callees = getCallees(db, targetSymbol.id);
  for (const callee of callees) {
    result.dependencies.push({
      file: callee.file_path ?? '',
      symbol: callee.name,
      line: callee.line_start,
    });
  }

  // === Co-change correlations ===
  const targetFile = targetSymbol.file_path;
  if (targetFile) {
    const coChanges = getCoChanges(db, targetFile);
    for (const cc of coChanges.slice(0, 10)) {
      result.coChangeCorrelations.push({
        file: cc.file,
        confidence: cc.confidence,
        changeCount: cc.change_count,
      });
    }
  }

  // === Tests ===
  const testFiles = db.prepare(`
    SELECT DISTINCT f.path, s.name, s.line_start
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE f.path LIKE '%test%'
    AND EXISTS (
      SELECT 1 FROM calls c
      WHERE c.caller_symbol_id = s.id AND c.callee_symbol_id = ?
    )
  `).all(targetSymbol.id) as Array<{ path: string; name: string; line_start: number }>;

  for (const test of testFiles) {
    result.tests.push({ file: test.path, testName: test.name, line: test.line_start });
  }

  if (targetFile) {
    const baseName = targetFile.replace(/\.[^.]+$/, '');
    const testByName = db.prepare(`
      SELECT path FROM files
      WHERE (path LIKE ? OR path LIKE ?) AND path LIKE '%test%'
    `).all(`${baseName}.test.%`, `${baseName}.spec.%`) as Array<{ path: string }>;

    for (const tf of testByName) {
      if (!result.tests.some((t) => t.file === tf.path)) {
        result.tests.push({ file: tf.path, testName: null, line: 1 });
      }
    }
  }

  // === Compute blast radius ===
  result.blastRadius = computeBlastRadius(result);

  return result;
}

function computeRisk(filePath: string, isExported: boolean, db: Database.Database, symbolId: number): 'high' | 'medium' | 'low' {
  const isTest = filePath.includes('test') || filePath.includes('spec');
  if (isTest) return 'low';

  // Count how many callers this dependent has (cascade risk)
  const callerCount = (db.prepare(
    'SELECT COUNT(*) as c FROM calls WHERE callee_symbol_id = ?',
  ).get(symbolId) as { c: number }).c;

  if (isExported && callerCount > 3) return 'high';
  if (isExported || callerCount > 1) return 'medium';
  return 'low';
}

function computeBlastRadius(result: ImpactResult): ImpactResult['blastRadius'] {
  const allDeps = [...result.directDependents, ...result.indirectDependents];

  const coreFiles = new Set<string>();
  const testFiles = new Set<string>();

  for (const dep of allDeps) {
    if (dep.file.includes('test') || dep.file.includes('spec')) {
      testFiles.add(dep.file);
    } else {
      coreFiles.add(dep.file);
    }
  }

  const signatureBreaks = result.directDependents.length;
  const behaviorAffects = result.indirectDependents.length;

  // Score: weighted sum
  let score = 0;
  score += signatureBreaks * 10;  // each direct dependent = 10 points
  score += behaviorAffects * 3;   // each indirect = 3 points
  score += coreFiles.size * 5;    // each core file affected = 5 points
  score += result.directDependents.filter((d) => d.risk === 'high').length * 15; // high risk bonus

  // Penalty if no tests cover this
  if (result.tests.length === 0 && signatureBreaks > 0) score += 20;

  score = Math.min(score, 100);

  let level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  if (score >= 80) level = 'CRITICAL';
  else if (score >= 50) level = 'HIGH';
  else if (score >= 20) level = 'MEDIUM';
  else level = 'LOW';

  return {
    level,
    signatureBreaks,
    behaviorAffects,
    coreFiles: coreFiles.size,
    testFiles: testFiles.size,
    score,
  };
}

function parseTarget(target: string): { filePath: string | null; line: number | null; symbolName: string | null } {
  const lineMatch = target.match(/^(.+):(\d+)$/);
  if (lineMatch) return { filePath: lineMatch[1], line: parseInt(lineMatch[2], 10), symbolName: null };

  const nameMatch = target.match(/^(.+):([a-zA-Z_]\w*)$/);
  if (nameMatch) return { filePath: nameMatch[1], line: null, symbolName: nameMatch[2] };

  if (/^[a-zA-Z_]\w*$/.test(target)) return { filePath: null, line: null, symbolName: target };

  return { filePath: target, line: null, symbolName: null };
}
