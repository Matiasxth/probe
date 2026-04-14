import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { openDatabase, clearDatabase, setMeta, getMeta } from '../src/storage/database.js';
import {
  insertParsedFile,
  searchSymbols,
  getSymbolsByFile,
  getCallers,
  getCallees,
  findSymbolByName,
  findSymbolAt,
  getStats,
  getCoChanges,
  insertCoChange,
  getPatterns,
  insertPattern,
} from '../src/storage/queries.js';
import type { ParsedFile } from '../src/types.js';
import type Database from 'better-sqlite3';

const TEST_ROOT = path.join(__dirname, '.test-db');

describe('Storage layer', () => {
  let db: Database.Database;

  beforeAll(() => {
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    db = openDatabase(TEST_ROOT);
    clearDatabase(db);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('inserts and queries files', () => {
    const file: ParsedFile = {
      path: 'src/auth.ts',
      language: 'typescript',
      size: 500,
      hash: 'abc123',
      symbols: [
        { name: 'loginUser', kind: 'function', lineStart: 5, lineEnd: 15, signature: 'function loginUser()', docComment: '/** Login */\n', isExported: true, isDefault: false, parentName: null },
        { name: 'hashPassword', kind: 'function', lineStart: 17, lineEnd: 20, signature: 'function hashPassword()', docComment: null, isExported: false, isDefault: false, parentName: null },
      ],
      imports: [
        { sourcePath: './types', importedNames: ['User'], isDefault: false, isNamespace: false },
      ],
      callSites: [
        { callerName: 'loginUser', calleeName: 'hashPassword', line: 10 },
      ],
    };

    insertParsedFile(db, file);

    const stats = getStats(db);
    expect(stats.files).toBe(1);
    expect(stats.symbols).toBe(2);
  });

  it('searches symbols by name', () => {
    const results = searchSymbols(db, 'login');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('loginUser');
  });

  it('finds symbols by file', () => {
    const symbols = getSymbolsByFile(db, 'src/auth.ts');
    expect(symbols.length).toBe(2);
    expect(symbols[0].name).toBe('loginUser');
  });

  it('finds symbol by name', () => {
    const results = findSymbolByName(db, 'loginUser');
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe('function');
  });

  it('finds symbol at line', () => {
    const sym = findSymbolAt(db, 'src/auth.ts', 10);
    expect(sym).toBeDefined();
    expect(sym!.name).toBe('loginUser');
  });

  it('stores and retrieves metadata', () => {
    setMeta(db, 'test_key', 'test_value');
    expect(getMeta(db, 'test_key')).toBe('test_value');
    expect(getMeta(db, 'nonexistent')).toBeUndefined();
  });

  it('stores and retrieves co-changes', () => {
    insertCoChange(db, 'src/auth.ts', 'src/types.ts', 5, 10, 0.8);
    const coChanges = getCoChanges(db, 'src/auth.ts');
    expect(coChanges.length).toBe(1);
    expect(coChanges[0].file).toBe('src/types.ts');
    expect(coChanges[0].confidence).toBe(0.8);
  });

  it('stores and retrieves patterns', () => {
    insertPattern(db, 'naming', 'functions', 'camelCase', 10, 12, 0.83, ['src/auth.ts:5']);
    const patterns = getPatterns(db, 'naming');
    expect(patterns.length).toBe(1);
    expect(patterns[0].value).toBe('camelCase');
  });

  it('clears database', () => {
    clearDatabase(db);
    const stats = getStats(db);
    expect(stats.files).toBe(0);
    expect(stats.symbols).toBe(0);
  });
});
