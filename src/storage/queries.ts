import type Database from 'better-sqlite3';
import type { ParsedFile, ParsedSymbol, ParsedImport, ParsedCallSite } from '../types.js';

// ===== Insert operations =====

export function insertFile(db: Database.Database, file: ParsedFile): number {
  const result = db.prepare(
    'INSERT INTO files (path, language, size, hash) VALUES (?, ?, ?, ?)',
  ).run(file.path, file.language, file.size, file.hash);
  return result.lastInsertRowid as number;
}

export function insertSymbol(
  db: Database.Database,
  fileId: number,
  symbol: ParsedSymbol,
  parentSymbolId: number | null,
): number {
  const result = db.prepare(`
    INSERT INTO symbols (file_id, name, kind, line_start, line_end, signature, doc_comment, is_exported, is_default, parent_symbol_id, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    symbol.name,
    symbol.kind,
    symbol.lineStart,
    symbol.lineEnd,
    symbol.signature,
    symbol.docComment,
    symbol.isExported ? 1 : 0,
    symbol.isDefault ? 1 : 0,
    parentSymbolId,
    JSON.stringify(symbol.tags ?? []),
  );
  return result.lastInsertRowid as number;
}

export function insertImport(db: Database.Database, fileId: number, imp: ParsedImport): void {
  db.prepare(`
    INSERT INTO imports (file_id, source_path, imported_names, original_names, is_default, is_namespace)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    imp.sourcePath,
    JSON.stringify(imp.importedNames),
    JSON.stringify(imp.originalNames ?? {}),
    imp.isDefault ? 1 : 0,
    imp.isNamespace ? 1 : 0,
  );
}

export function insertCall(db: Database.Database, callerSymbolId: number, calleeSymbolId: number, line: number): void {
  db.prepare('INSERT INTO calls (caller_symbol_id, callee_symbol_id, line) VALUES (?, ?, ?)').run(
    callerSymbolId,
    calleeSymbolId,
    line,
  );
}

export function insertTypeRef(db: Database.Database, symbolId: number, referencedSymbolId: number): void {
  db.prepare('INSERT INTO type_refs (symbol_id, referenced_symbol_id) VALUES (?, ?)').run(symbolId, referencedSymbolId);
}

export function insertCoChange(
  db: Database.Database,
  filePathA: string,
  filePathB: string,
  changeCount: number,
  totalCommits: number,
  confidence: number,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO co_changes (file_path_a, file_path_b, change_count, total_commits, confidence)
    VALUES (?, ?, ?, ?, ?)
  `).run(filePathA, filePathB, changeCount, totalCommits, confidence);
}

export function insertPattern(
  db: Database.Database,
  category: string,
  name: string,
  value: string,
  instanceCount: number,
  totalCount: number,
  confidence: number,
  examples: string[],
): void {
  db.prepare(`
    INSERT OR REPLACE INTO patterns (category, name, value, instance_count, total_count, confidence, examples)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(category, name, value, instanceCount, totalCount, confidence, JSON.stringify(examples));
}

// ===== Bulk insert (transactional) =====

export function insertParsedFile(db: Database.Database, file: ParsedFile): void {
  const tx = db.transaction(() => {
    const fileId = insertFile(db, file);

    // Map symbol name → DB id for call resolution
    const symbolMap = new Map<string, number>();

    // Insert symbols (classes first, then methods as children)
    const classes = file.symbols.filter((s) => s.kind === 'class');
    const nonClasses = file.symbols.filter((s) => s.kind !== 'class');

    for (const cls of classes) {
      const clsId = insertSymbol(db, fileId, cls, null);
      symbolMap.set(cls.name, clsId);
    }

    for (const sym of nonClasses) {
      const parentId = sym.parentName ? (symbolMap.get(sym.parentName) ?? null) : null;
      const symId = insertSymbol(db, fileId, sym, parentId);
      const key = sym.parentName ? `${sym.parentName}.${sym.name}` : sym.name;
      symbolMap.set(key, symId);
      symbolMap.set(sym.name, symId);
    }

    // Insert imports
    for (const imp of file.imports) {
      insertImport(db, fileId, imp);
    }

    // Insert raw call sites for later resolution
    const insertCallSite = db.prepare(
      'INSERT INTO call_sites (file_id, caller_name, callee_name, line) VALUES (?, ?, ?, ?)',
    );
    for (const cs of file.callSites) {
      insertCallSite.run(fileId, cs.callerName, cs.calleeName, cs.line);
    }

    return { fileId, symbolMap };
  });

  tx();
}

// ===== Query operations =====

interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  line_start: number;
  line_end: number;
  signature: string;
  doc_comment: string | null;
  is_exported: number;
  is_default: number;
  parent_symbol_id: number | null;
  file_path?: string;
}

interface FileRow {
  id: number;
  path: string;
  language: string;
  size: number;
  hash: string;
}

export function searchSymbols(db: Database.Database, query: string): SymbolRow[] {
  // Try FTS first
  const ftsResults = db.prepare(`
    SELECT s.*, f.path as file_path
    FROM symbols_fts fts
    JOIN symbols s ON s.id = fts.rowid
    JOIN files f ON f.id = s.file_id
    WHERE symbols_fts MATCH ?
    LIMIT 50
  `).all(query.split(/\s+/).map((w) => `"${w}"`).join(' OR ')) as SymbolRow[];

  if (ftsResults.length > 0) return ftsResults;

  // Fallback to LIKE
  return db.prepare(`
    SELECT s.*, f.path as file_path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.name LIKE ? OR s.signature LIKE ?
    LIMIT 50
  `).all(`%${query}%`, `%${query}%`) as SymbolRow[];
}

export function getSymbolById(db: Database.Database, id: number): SymbolRow | undefined {
  return db.prepare(`
    SELECT s.*, f.path as file_path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.id = ?
  `).get(id) as SymbolRow | undefined;
}

export function getSymbolsByFile(db: Database.Database, filePath: string): SymbolRow[] {
  return db.prepare(`
    SELECT s.*, f.path as file_path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE f.path = ?
    ORDER BY s.line_start
  `).all(filePath) as SymbolRow[];
}

export function getExportedSymbols(db: Database.Database): SymbolRow[] {
  return db.prepare(`
    SELECT s.*, f.path as file_path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.is_exported = 1
  `).all() as SymbolRow[];
}

export function getCallers(db: Database.Database, symbolId: number): Array<SymbolRow & { call_line: number }> {
  return db.prepare(`
    SELECT s.*, f.path as file_path, c.line as call_line
    FROM calls c
    JOIN symbols s ON s.id = c.caller_symbol_id
    JOIN files f ON f.id = s.file_id
    WHERE c.callee_symbol_id = ?
  `).all(symbolId) as Array<SymbolRow & { call_line: number }>;
}

export function getCallees(db: Database.Database, symbolId: number): Array<SymbolRow & { call_line: number }> {
  return db.prepare(`
    SELECT s.*, f.path as file_path, c.line as call_line
    FROM calls c
    JOIN symbols s ON s.id = c.callee_symbol_id
    JOIN files f ON f.id = s.file_id
    WHERE c.caller_symbol_id = ?
  `).all(symbolId) as Array<SymbolRow & { call_line: number }>;
}

export function getTypeRefs(db: Database.Database, symbolId: number): SymbolRow[] {
  return db.prepare(`
    SELECT s.*, f.path as file_path
    FROM type_refs tr
    JOIN symbols s ON s.id = tr.referenced_symbol_id
    JOIN files f ON f.id = s.file_id
    WHERE tr.symbol_id = ?
  `).all(symbolId) as SymbolRow[];
}

export function getTypeUsers(db: Database.Database, symbolId: number): SymbolRow[] {
  return db.prepare(`
    SELECT s.*, f.path as file_path
    FROM type_refs tr
    JOIN symbols s ON s.id = tr.symbol_id
    JOIN files f ON f.id = s.file_id
    WHERE tr.referenced_symbol_id = ?
  `).all(symbolId) as SymbolRow[];
}

export function getCoChanges(db: Database.Database, filePath: string): Array<{ file: string; change_count: number; total_commits: number; confidence: number }> {
  return db.prepare(`
    SELECT file_path_b as file, change_count, total_commits, confidence
    FROM co_changes WHERE file_path_a = ?
    UNION
    SELECT file_path_a as file, change_count, total_commits, confidence
    FROM co_changes WHERE file_path_b = ?
    ORDER BY confidence DESC
  `).all(filePath, filePath) as Array<{ file: string; change_count: number; total_commits: number; confidence: number }>;
}

export function getPatterns(db: Database.Database, category?: string): Array<{
  category: string; name: string; value: string;
  instance_count: number; total_count: number; confidence: number; examples: string;
}> {
  if (category) {
    return db.prepare('SELECT * FROM patterns WHERE category = ? ORDER BY confidence DESC').all(category) as any[];
  }
  return db.prepare('SELECT * FROM patterns ORDER BY category, confidence DESC').all() as any[];
}

export function getFileByPath(db: Database.Database, filePath: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as FileRow | undefined;
}

export function getAllFiles(db: Database.Database): FileRow[] {
  return db.prepare('SELECT * FROM files ORDER BY path').all() as FileRow[];
}

export function getImportsByFile(db: Database.Database, fileId: number): Array<{
  source_path: string; imported_names: string; is_default: number; is_namespace: number;
}> {
  return db.prepare('SELECT source_path, imported_names, is_default, is_namespace FROM imports WHERE file_id = ?').all(fileId) as any[];
}

export function getStats(db: Database.Database): {
  files: number; symbols: number; calls: number; coChanges: number; patterns: number;
  languages: Record<string, number>;
} {
  const files = (db.prepare('SELECT COUNT(*) as c FROM files').get() as any).c;
  const symbols = (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as any).c;
  const calls = (db.prepare('SELECT COUNT(*) as c FROM calls').get() as any).c;
  const coChanges = (db.prepare('SELECT COUNT(*) as c FROM co_changes').get() as any).c;
  const patterns = (db.prepare('SELECT COUNT(*) as c FROM patterns').get() as any).c;

  const langRows = db.prepare('SELECT language, COUNT(*) as c FROM files GROUP BY language').all() as Array<{ language: string; c: number }>;
  const languages: Record<string, number> = {};
  for (const row of langRows) languages[row.language] = row.c;

  return { files, symbols, calls, coChanges, patterns, languages };
}

export function findSymbolAt(db: Database.Database, filePath: string, line: number): SymbolRow | undefined {
  return db.prepare(`
    SELECT s.*, f.path as file_path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE f.path = ? AND s.line_start <= ? AND s.line_end >= ?
    ORDER BY (s.line_end - s.line_start) ASC
    LIMIT 1
  `).get(filePath, line, line) as SymbolRow | undefined;
}

export function findSymbolByName(db: Database.Database, name: string): SymbolRow[] {
  return db.prepare(`
    SELECT s.*, f.path as file_path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.name = ?
  `).all(name) as SymbolRow[];
}
