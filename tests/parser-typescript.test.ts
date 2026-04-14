import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getParser, parseSource } from '../src/parser/tree-sitter.js';
import { extractTypeScript } from '../src/parser/extractors/typescript.js';

const FIXTURE = path.join(__dirname, 'fixtures/sample.ts');

describe('TypeScript parser', () => {
  let result: ReturnType<typeof extractTypeScript>;

  beforeAll(async () => {
    const source = fs.readFileSync(FIXTURE, 'utf-8');
    const parser = await getParser('typescript', false);
    expect(parser).toBeTruthy();
    const tree = parseSource(parser!, source);
    result = extractTypeScript(tree, source);
  });

  describe('symbols', () => {
    it('extracts exported functions', () => {
      const login = result.symbols.find((s) => s.name === 'loginUser');
      expect(login).toBeDefined();
      expect(login!.kind).toBe('function');
      expect(login!.isExported).toBe(true);
      expect(login!.signature).toContain('loginUser');
    });

    it('extracts non-exported functions', () => {
      const hash = result.symbols.find((s) => s.name === 'hashPassword');
      expect(hash).toBeDefined();
      expect(hash!.kind).toBe('function');
      expect(hash!.isExported).toBe(false);
    });

    it('extracts classes', () => {
      const cls = result.symbols.find((s) => s.name === 'AuthController');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
      expect(cls!.isExported).toBe(true);
    });

    it('extracts methods with parent class', () => {
      const method = result.symbols.find((s) => s.name === 'handleLogin');
      expect(method).toBeDefined();
      expect(method!.kind).toBe('method');
      expect(method!.parentName).toBe('AuthController');
    });

    it('extracts interfaces', () => {
      const iface = result.symbols.find((s) => s.name === 'AuthConfig');
      expect(iface).toBeDefined();
      expect(iface!.kind).toBe('interface');
      expect(iface!.isExported).toBe(true);
    });

    it('extracts type aliases', () => {
      const type = result.symbols.find((s) => s.name === 'TokenPayload');
      expect(type).toBeDefined();
      expect(type!.kind).toBe('type');
    });

    it('extracts enums', () => {
      const en = result.symbols.find((s) => s.name === 'AuthRole');
      expect(en).toBeDefined();
      expect(en!.kind).toBe('enum');
    });

    it('captures doc comments', () => {
      const login = result.symbols.find((s) => s.name === 'loginUser');
      expect(login!.docComment).not.toBeNull();
      expect(login!.docComment).toContain('Authenticates a user');
    });

    it('captures line numbers', () => {
      const login = result.symbols.find((s) => s.name === 'loginUser');
      expect(login!.lineStart).toBeGreaterThan(0);
      expect(login!.lineEnd).toBeGreaterThanOrEqual(login!.lineStart);
    });
  });

  describe('imports', () => {
    it('extracts named imports', () => {
      const imp = result.imports.find((i) => i.sourcePath === './user-service');
      expect(imp).toBeDefined();
      expect(imp!.importedNames).toContain('UserService');
    });

    it('extracts type imports', () => {
      const imp = result.imports.find((i) => i.sourcePath === './types');
      expect(imp).toBeDefined();
      expect(imp!.importedNames).toContain('User');
    });
  });

  describe('call sites', () => {
    it('detects function calls inside functions', () => {
      const calls = result.callSites.filter((c) => c.callerName === 'loginUser');
      const calleeNames = calls.map((c) => c.calleeName);
      expect(calleeNames).toContain('validatePassword');
    });

    it('detects method calls', () => {
      const calls = result.callSites.filter((c) => c.callerName === 'loginUser');
      const calleeNames = calls.map((c) => c.calleeName);
      expect(calleeNames).toContain('findByEmail');
    });

    it('includes line numbers', () => {
      const call = result.callSites.find((c) => c.calleeName === 'validatePassword');
      expect(call).toBeDefined();
      expect(call!.line).toBeGreaterThan(0);
    });

    it('tracks calls inside methods', () => {
      const calls = result.callSites.filter((c) => c.callerName === 'AuthController.handleLogin');
      const calleeNames = calls.map((c) => c.calleeName);
      expect(calleeNames).toContain('loginUser');
    });
  });
});
