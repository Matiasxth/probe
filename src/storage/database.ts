import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  doc_comment TEXT,
  is_exported INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  imported_names TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  is_namespace INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  line INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS type_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  referenced_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS co_changes (
  file_path_a TEXT NOT NULL,
  file_path_b TEXT NOT NULL,
  change_count INTEGER NOT NULL,
  total_commits INTEGER NOT NULL,
  confidence REAL NOT NULL,
  PRIMARY KEY (file_path_a, file_path_b)
);

CREATE TABLE IF NOT EXISTS patterns (
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  instance_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  confidence REAL NOT NULL,
  examples TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (category, name)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(is_exported);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source_path);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_symbol_id);
CREATE INDEX IF NOT EXISTS idx_type_refs_symbol ON type_refs(symbol_id);
CREATE INDEX IF NOT EXISTS idx_type_refs_ref ON type_refs(referenced_symbol_id);
CREATE INDEX IF NOT EXISTS idx_co_changes_a ON co_changes(file_path_a);
CREATE INDEX IF NOT EXISTS idx_co_changes_b ON co_changes(file_path_b);

-- FTS for symbol name search
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, signature, doc_comment, content=symbols, content_rowid=id);

CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, signature, doc_comment) VALUES (new.id, new.name, new.signature, new.doc_comment);
END;
`;

export function openDatabase(root: string): Database.Database {
  const probeDir = path.join(root, '.probe');
  if (!fs.existsSync(probeDir)) {
    fs.mkdirSync(probeDir, { recursive: true });
  }

  const dbPath = path.join(probeDir, 'probe.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);

  return db;
}

export function clearDatabase(db: Database.Database): void {
  db.exec(`
    DELETE FROM calls;
    DELETE FROM type_refs;
    DELETE FROM imports;
    DELETE FROM symbols;
    DELETE FROM files;
    DELETE FROM co_changes;
    DELETE FROM patterns;
    DELETE FROM meta;
    DELETE FROM symbols_fts;
  `);
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}
