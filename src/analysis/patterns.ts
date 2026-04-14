import type Database from 'better-sqlite3';
import { insertPattern } from '../storage/queries.js';

interface SymbolRow {
  name: string;
  kind: string;
  signature: string;
  is_exported: number;
  file_path: string;
  line_start: number;
}

export function extractPatterns(db: Database.Database): number {
  const symbols = db.prepare(`
    SELECT s.name, s.kind, s.signature, s.is_exported, f.path as file_path, s.line_start
    FROM symbols s
    JOIN files f ON f.id = s.file_id
  `).all() as SymbolRow[];

  const files = db.prepare('SELECT path, language FROM files').all() as Array<{ path: string; language: string }>;

  let count = 0;

  // === Naming conventions ===
  count += analyzeNaming(db, symbols, 'function');
  count += analyzeNaming(db, symbols, 'class');
  count += analyzeNaming(db, symbols, 'method');
  count += analyzeNaming(db, symbols, 'variable');

  // === File naming ===
  count += analyzeFileNaming(db, files);

  // === Error handling patterns ===
  count += analyzeErrorHandling(db, symbols);

  // === Export patterns ===
  count += analyzeExportPatterns(db, symbols);

  // === Test patterns ===
  count += analyzeTestPatterns(db, files);

  // === Import patterns ===
  count += analyzeImportPatterns(db);

  return count;
}

function analyzeNaming(db: Database.Database, symbols: SymbolRow[], kind: string): number {
  const filtered = symbols.filter((s) => s.kind === kind && s.name.length > 1);
  if (filtered.length < 3) return 0;

  const conventions = {
    camelCase: 0,
    PascalCase: 0,
    snake_case: 0,
    UPPER_CASE: 0,
    'kebab-case': 0,
  };

  const examples: Record<string, string[]> = {};

  for (const sym of filtered) {
    const name = sym.name;
    const convention = detectNamingConvention(name);
    if (convention) {
      conventions[convention]++;
      if (!examples[convention]) examples[convention] = [];
      if (examples[convention].length < 3) {
        examples[convention].push(`${sym.file_path}:${sym.line_start}`);
      }
    }
  }

  // Find dominant convention
  const sorted = Object.entries(conventions).sort((a, b) => b[1] - a[1]);
  const [bestConvention, bestCount] = sorted[0];
  if (bestCount === 0) return 0;

  const confidence = bestCount / filtered.length;
  const outliers = filtered
    .filter((s) => detectNamingConvention(s.name) !== bestConvention)
    .slice(0, 5)
    .map((s) => `${s.file_path}:${s.line_start} (${s.name})`);

  insertPattern(
    db, 'naming', `${kind}_convention`, bestConvention,
    bestCount, filtered.length, Math.round(confidence * 100) / 100,
    examples[bestConvention] ?? [],
  );

  if (outliers.length > 0 && confidence < 1) {
    insertPattern(
      db, 'naming', `${kind}_outliers`, outliers.join('; '),
      outliers.length, filtered.length, 1 - confidence,
      outliers.slice(0, 3),
    );
  }

  return 1;
}

function detectNamingConvention(name: string): keyof typeof CONVENTIONS | null {
  if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) return 'camelCase';
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return 'PascalCase';
  if (/^[a-z][a-z0-9_]*$/.test(name) && name.includes('_')) return 'snake_case';
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) return 'UPPER_CASE';
  if (/^[a-z][a-z0-9-]*$/.test(name) && name.includes('-')) return 'kebab-case';
  if (/^[a-z][a-z0-9]*$/.test(name)) return 'camelCase'; // single word lowercase = camelCase
  return null;
}

const CONVENTIONS = { camelCase: 0, PascalCase: 0, snake_case: 0, UPPER_CASE: 0, 'kebab-case': 0 };

function analyzeFileNaming(db: Database.Database, files: Array<{ path: string; language: string }>): number {
  if (files.length < 3) return 0;

  const conventions = { camelCase: 0, PascalCase: 0, snake_case: 0, 'kebab-case': 0 };
  const examples: Record<string, string[]> = {};

  for (const file of files) {
    const basename = file.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
    if (basename.length < 2) continue;

    let conv: string | null = null;
    if (/^[a-z][a-zA-Z0-9]*$/.test(basename) && /[A-Z]/.test(basename)) conv = 'camelCase';
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(basename)) conv = 'PascalCase';
    else if (/^[a-z][a-z0-9_]*$/.test(basename) && basename.includes('_')) conv = 'snake_case';
    else if (/^[a-z][a-z0-9-]*$/.test(basename) && basename.includes('-')) conv = 'kebab-case';
    else if (/^[a-z][a-z0-9]*$/.test(basename)) conv = 'camelCase';

    if (conv) {
      (conventions as any)[conv]++;
      if (!examples[conv]) examples[conv] = [];
      if (examples[conv].length < 3) examples[conv].push(file.path);
    }
  }

  const sorted = Object.entries(conventions).sort((a, b) => b[1] - a[1]);
  const [best, count] = sorted[0];
  if (count === 0) return 0;

  const confidence = count / files.length;
  insertPattern(
    db, 'naming', 'file_convention', best,
    count, files.length, Math.round(confidence * 100) / 100,
    examples[best] ?? [],
  );
  return 1;
}

function analyzeErrorHandling(db: Database.Database, symbols: SymbolRow[]): number {
  const functions = symbols.filter((s) => s.kind === 'function' || s.kind === 'method');
  if (functions.length < 3) return 0;

  let resultPattern = 0;
  let throwsPattern = 0;
  let promisePattern = 0;
  const resultExamples: string[] = [];
  const throwsExamples: string[] = [];

  for (const fn of functions) {
    const sig = fn.signature.toLowerCase();
    if (sig.includes('result<') || sig.includes('result[') || sig.includes('-> result')) {
      resultPattern++;
      if (resultExamples.length < 3) resultExamples.push(`${fn.file_path}:${fn.line_start}`);
    }
    if (sig.includes('throws') || sig.includes('error')) {
      throwsPattern++;
      if (throwsExamples.length < 3) throwsExamples.push(`${fn.file_path}:${fn.line_start}`);
    }
    if (sig.includes('promise<') || sig.includes('async')) {
      promisePattern++;
    }
  }

  let count = 0;
  if (resultPattern > 2) {
    insertPattern(
      db, 'error_handling', 'result_type', 'Result<T, E> pattern',
      resultPattern, functions.length, resultPattern / functions.length,
      resultExamples,
    );
    count++;
  }

  if (promisePattern > 2) {
    insertPattern(
      db, 'structure', 'async_pattern', 'async/Promise',
      promisePattern, functions.length, promisePattern / functions.length,
      [],
    );
    count++;
  }

  return count;
}

function analyzeExportPatterns(db: Database.Database, symbols: SymbolRow[]): number {
  const exported = symbols.filter((s) => s.is_exported);
  const total = symbols.length;
  if (total === 0) return 0;

  const ratio = exported.length / total;
  insertPattern(
    db, 'structure', 'export_ratio', `${exported.length}/${total} symbols exported`,
    exported.length, total, Math.round(ratio * 100) / 100,
    exported.slice(0, 3).map((s) => `${s.file_path}:${s.line_start}`),
  );

  return 1;
}

function analyzeTestPatterns(db: Database.Database, files: Array<{ path: string; language: string }>): number {
  const testFiles = files.filter((f) =>
    f.path.includes('test') || f.path.includes('spec') || f.path.includes('__tests__'),
  );

  if (testFiles.length === 0) return 0;

  // Detect location pattern
  const inSrc = testFiles.filter((f) => f.path.startsWith('src/'));
  const inTests = testFiles.filter((f) => f.path.startsWith('tests/') || f.path.startsWith('test/'));
  const coLocated = testFiles.filter((f) => !f.path.startsWith('tests/') && !f.path.startsWith('test/'));

  let location = 'unknown';
  if (inTests.length > coLocated.length) location = 'separate tests/ directory';
  else if (coLocated.length > inTests.length) location = 'co-located with source';

  // Detect naming pattern
  const dotTest = testFiles.filter((f) => f.path.includes('.test.'));
  const dotSpec = testFiles.filter((f) => f.path.includes('.spec.'));
  const underscoreTest = testFiles.filter((f) => f.path.includes('_test.'));

  let naming = 'unknown';
  if (dotTest.length > dotSpec.length && dotTest.length > underscoreTest.length) naming = '*.test.*';
  else if (dotSpec.length > dotTest.length) naming = '*.spec.*';
  else if (underscoreTest.length > dotTest.length) naming = '*_test.*';

  insertPattern(
    db, 'tests', 'location', location,
    Math.max(inTests.length, coLocated.length), testFiles.length, 1,
    testFiles.slice(0, 3).map((f) => f.path),
  );

  insertPattern(
    db, 'tests', 'naming', naming,
    testFiles.length, files.length, testFiles.length / files.length,
    testFiles.slice(0, 3).map((f) => f.path),
  );

  insertPattern(
    db, 'tests', 'coverage_ratio', `${testFiles.length} test files / ${files.length} total files`,
    testFiles.length, files.length, testFiles.length / files.length,
    [],
  );

  return 3;
}

function analyzeImportPatterns(db: Database.Database): number {
  const imports = db.prepare(`
    SELECT i.source_path, i.is_namespace, f.language
    FROM imports i
    JOIN files f ON f.id = i.file_id
  `).all() as Array<{ source_path: string; is_namespace: number; language: string }>;

  if (imports.length < 5) return 0;

  const relative = imports.filter((i) => i.source_path.startsWith('.'));
  const absolute = imports.filter((i) => !i.source_path.startsWith('.'));

  const relRatio = relative.length / imports.length;

  insertPattern(
    db, 'imports', 'style', relRatio > 0.5 ? 'mostly relative' : 'mostly absolute/package',
    Math.max(relative.length, absolute.length), imports.length,
    Math.round(Math.max(relRatio, 1 - relRatio) * 100) / 100,
    [],
  );

  return 1;
}
