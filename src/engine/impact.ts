import type Database from 'better-sqlite3';
import type { ImpactResult, SymbolKind } from '../types.js';
import {
  findSymbolAt,
  findSymbolByName,
  getCallers,
  getTypeUsers,
  getCoChanges,
  getSymbolsByFile,
} from '../storage/queries.js';

export function analyzeImpact(
  db: Database.Database,
  target: string,
  maxDepth: number = 3,
): ImpactResult | null {
  // Parse target: "file.ts:line" or "file.ts:functionName" or "functionName"
  const { filePath, line, symbolName } = parseTarget(target);

  // Find the target symbol
  let targetSymbol;

  if (filePath && line) {
    targetSymbol = findSymbolAt(db, filePath, line);
  } else if (filePath && symbolName) {
    const fileSymbols = getSymbolsByFile(db, filePath);
    targetSymbol = fileSymbols.find((s) => s.name === symbolName);
  } else if (symbolName) {
    const candidates = findSymbolByName(db, symbolName);
    // Prefer exported
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
    coChangeCorrelations: [],
    tests: [],
  };

  // === Direct dependents (who calls this?) ===
  const directCallers = getCallers(db, targetSymbol.id);
  for (const caller of directCallers) {
    result.directDependents.push({
      file: caller.file_path ?? '',
      symbol: caller.name,
      line: caller.call_line || caller.line_start,
      type: 'call',
    });
  }

  // === Type dependents ===
  const typeUsers = getTypeUsers(db, targetSymbol.id);
  for (const user of typeUsers) {
    const alreadyAdded = result.directDependents.some(
      (d) => d.file === user.file_path && d.symbol === user.name,
    );
    if (!alreadyAdded) {
      result.directDependents.push({
        file: user.file_path ?? '',
        symbol: user.name,
        line: user.line_start,
        type: 'type',
      });
    }
  }

  // === Indirect dependents (BFS through call graph) ===
  if (maxDepth > 1) {
    const visited = new Set<number>([targetSymbol.id]);
    const queue: Array<{ id: number; depth: number }> = [];

    // Start from direct callers
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

        if (depth < maxDepth) {
          queue.push({ id: caller.id, depth: depth + 1 });
        }
      }
    }
  }

  // === Co-change correlations ===
  const filePath_ = targetSymbol.file_path;
  if (filePath_) {
    const coChanges = getCoChanges(db, filePath_);
    for (const cc of coChanges.slice(0, 10)) {
      result.coChangeCorrelations.push({
        file: cc.file,
        confidence: cc.confidence,
        changeCount: cc.change_count,
      });
    }
  }

  // === Tests ===
  // Find test files that reference this symbol
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
    result.tests.push({
      file: test.path,
      testName: test.name,
      line: test.line_start,
    });
  }

  // Also find test files by naming convention
  if (filePath_) {
    const baseName = filePath_.replace(/\.[^.]+$/, '');
    const testByName = db.prepare(`
      SELECT path FROM files
      WHERE (path LIKE ? OR path LIKE ?)
      AND path LIKE '%test%'
    `).all(`${baseName}.test.%`, `${baseName}.spec.%`) as Array<{ path: string }>;

    for (const tf of testByName) {
      if (!result.tests.some((t) => t.file === tf.path)) {
        result.tests.push({ file: tf.path, testName: null, line: 1 });
      }
    }
  }

  return result;
}

function parseTarget(target: string): { filePath: string | null; line: number | null; symbolName: string | null } {
  // "src/auth/service.ts:45"
  const lineMatch = target.match(/^(.+):(\d+)$/);
  if (lineMatch) {
    return { filePath: lineMatch[1], line: parseInt(lineMatch[2], 10), symbolName: null };
  }

  // "src/auth/service.ts:loginUser"
  const nameMatch = target.match(/^(.+):([a-zA-Z_]\w*)$/);
  if (nameMatch) {
    return { filePath: nameMatch[1], line: null, symbolName: nameMatch[2] };
  }

  // "loginUser" (just a symbol name)
  if (/^[a-zA-Z_]\w*$/.test(target)) {
    return { filePath: null, line: null, symbolName: target };
  }

  // Assume it's a file path
  return { filePath: target, line: null, symbolName: null };
}
