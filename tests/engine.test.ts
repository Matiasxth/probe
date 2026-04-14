import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { openDatabase, clearDatabase } from '../src/storage/database.js';
import { insertParsedFile } from '../src/storage/queries.js';
import { queryCodebase } from '../src/engine/query.js';
import { analyzeImpact } from '../src/engine/impact.js';
import { resolveCallGraph } from '../src/parser/index.js';
import type { ParsedFile } from '../src/types.js';
import type Database from 'better-sqlite3';

const TEST_ROOT = path.join(__dirname, '.test-engine');

describe('Query engine', () => {
  let db: Database.Database;

  beforeAll(() => {
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    db = openDatabase(TEST_ROOT);
    clearDatabase(db);

    // Insert test data simulating a small project
    const authService: ParsedFile = {
      path: 'src/auth/service.ts',
      language: 'typescript',
      size: 800,
      hash: 'aaa',
      symbols: [
        { name: 'loginUser', kind: 'function', lineStart: 5, lineEnd: 20, signature: 'async function loginUser(email: string, password: string)', docComment: null, isExported: true, isDefault: false, parentName: null },
        { name: 'validateToken', kind: 'function', lineStart: 22, lineEnd: 30, signature: 'function validateToken(token: string)', docComment: null, isExported: true, isDefault: false, parentName: null },
      ],
      imports: [{ sourcePath: './session', importedNames: ['createSession'], isDefault: false, isNamespace: false }],
      callSites: [
        { callerName: 'loginUser', calleeName: 'createSession', line: 15 },
      ],
    };

    const session: ParsedFile = {
      path: 'src/auth/session.ts',
      language: 'typescript',
      size: 400,
      hash: 'bbb',
      symbols: [
        { name: 'createSession', kind: 'function', lineStart: 3, lineEnd: 15, signature: 'function createSession(userId: string)', docComment: null, isExported: true, isDefault: false, parentName: null },
      ],
      imports: [],
      callSites: [],
    };

    const routes: ParsedFile = {
      path: 'src/routes/auth.ts',
      language: 'typescript',
      size: 600,
      hash: 'ccc',
      symbols: [
        { name: 'handleLogin', kind: 'function', lineStart: 10, lineEnd: 25, signature: 'async function handleLogin(req: Request)', docComment: null, isExported: true, isDefault: false, parentName: null },
      ],
      imports: [{ sourcePath: '../auth/service', importedNames: ['loginUser'], isDefault: false, isNamespace: false }],
      callSites: [
        { callerName: 'handleLogin', calleeName: 'loginUser', line: 18 },
      ],
    };

    const authTest: ParsedFile = {
      path: 'tests/auth.test.ts',
      language: 'typescript',
      size: 300,
      hash: 'ddd',
      symbols: [
        { name: 'testLogin', kind: 'function', lineStart: 5, lineEnd: 20, signature: 'function testLogin()', docComment: null, isExported: false, isDefault: false, parentName: null },
      ],
      imports: [{ sourcePath: '../src/auth/service', importedNames: ['loginUser'], isDefault: false, isNamespace: false }],
      callSites: [
        { callerName: 'testLogin', calleeName: 'loginUser', line: 10 },
      ],
    };

    insertParsedFile(db, authService);
    insertParsedFile(db, session);
    insertParsedFile(db, routes);
    insertParsedFile(db, authTest);

    resolveCallGraph(db);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  describe('queryCodebase', () => {
    it('finds symbols by keyword', () => {
      const results = queryCodebase(db, 'login', { limit: 10 });
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.symbol).filter(Boolean);
      expect(names).toContain('loginUser');
    });

    it('finds files by path keyword', () => {
      const results = queryCodebase(db, 'session', { limit: 10 });
      const files = results.map((r) => r.file);
      expect(files).toContain('src/auth/session.ts');
    });

    it('includes call graph context', () => {
      const results = queryCodebase(db, 'login', { limit: 10 });
      const loginResult = results.find((r) => r.symbol === 'loginUser');
      // Should have calledBy or calls populated
      expect(loginResult).toBeDefined();
    });

    it('ranks exact matches higher', () => {
      const results = queryCodebase(db, 'loginUser', { limit: 10 });
      expect(results[0].symbol).toBe('loginUser');
      expect(results[0].relevance).toBeGreaterThanOrEqual(80);
    });

    it('respects limit', () => {
      const results = queryCodebase(db, 'auth', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('analyzeImpact', () => {
    it('finds direct dependents by function name', () => {
      const result = analyzeImpact(db, 'loginUser');
      expect(result).not.toBeNull();
      expect(result!.target.symbol).toBe('loginUser');
      const depNames = result!.directDependents.map((d) => d.symbol);
      expect(depNames).toContain('handleLogin');
    });

    it('finds test coverage', () => {
      const result = analyzeImpact(db, 'loginUser');
      expect(result).not.toBeNull();
      // testLogin calls loginUser, and its file contains "test"
      const testFiles = result!.tests.map((t) => t.file);
      expect(testFiles.some((f) => f.includes('test'))).toBe(true);
    });

    it('finds by file:line', () => {
      const result = analyzeImpact(db, 'src/auth/service.ts:10');
      expect(result).not.toBeNull();
      expect(result!.target.symbol).toBe('loginUser');
    });

    it('finds by file:name', () => {
      const result = analyzeImpact(db, 'src/auth/service.ts:validateToken');
      expect(result).not.toBeNull();
      expect(result!.target.symbol).toBe('validateToken');
    });

    it('returns null for unknown symbol', () => {
      const result = analyzeImpact(db, 'nonExistentFunction');
      expect(result).toBeNull();
    });

    it('includes indirect dependents', () => {
      // createSession ← loginUser ← handleLogin
      const result = analyzeImpact(db, 'createSession', 3);
      expect(result).not.toBeNull();
      const directNames = result!.directDependents.map((d) => d.symbol);
      expect(directNames).toContain('loginUser');
      // handleLogin should be indirect (depth 2)
      const allDeps = [...result!.directDependents, ...result!.indirectDependents].map((d) => d.symbol);
      expect(allDeps).toContain('handleLogin');
    });
  });
});
