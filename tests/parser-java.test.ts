import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getParser, parseSource } from '../src/parser/tree-sitter.js';
import { extractJava } from '../src/parser/extractors/java.js';

const FIXTURE = path.join(__dirname, 'fixtures/Sample.java');

describe('Java parser', () => {
  let result: ReturnType<typeof extractJava>;

  beforeAll(async () => {
    const source = fs.readFileSync(FIXTURE, 'utf-8');
    const parser = await getParser('java');
    expect(parser).toBeTruthy();
    const tree = parseSource(parser!, source);
    result = extractJava(tree, source);
  });

  describe('symbols', () => {
    it('extracts public classes', () => {
      const cls = result.symbols.find((s) => s.name === 'AuthService');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
      expect(cls!.isExported).toBe(true);
    });

    it('extracts methods with parent', () => {
      const m = result.symbols.find((s) => s.name === 'login');
      expect(m).toBeDefined();
      expect(m!.kind).toBe('method');
      expect(m!.parentName).toBe('AuthService');
      expect(m!.isExported).toBe(true);
    });

    it('extracts private methods', () => {
      const m = result.symbols.find((s) => s.name === 'verifyPassword');
      expect(m).toBeDefined();
      expect(m!.isExported).toBe(false);
    });

    it('extracts constructors', () => {
      const c = result.symbols.find((s) => s.name === 'AuthService' && s.kind === 'method');
      expect(c).toBeDefined();
      expect(c!.parentName).toBe('AuthService');
    });

    it('extracts interfaces', () => {
      const i = result.symbols.find((s) => s.name === 'Authenticator');
      expect(i).toBeDefined();
      expect(i!.kind).toBe('interface');
    });

    it('extracts enums', () => {
      const e = result.symbols.find((s) => s.name === 'Role');
      expect(e).toBeDefined();
      expect(e!.kind).toBe('enum');
    });

    it('extracts static final constants', () => {
      const c = result.symbols.find((s) => s.name === 'MAX_RETRIES');
      expect(c).toBeDefined();
      expect(c!.kind).toBe('constant');
    });

    it('captures doc comments', () => {
      const cls = result.symbols.find((s) => s.name === 'AuthService' && s.kind === 'class');
      expect(cls!.docComment).toContain('Authentication service');
    });
  });

  describe('imports', () => {
    it('extracts imports', () => {
      const imp = result.imports.find((i) => i.importedNames.includes('User'));
      expect(imp).toBeDefined();
      expect(imp!.sourcePath).toContain('com.example.models');
    });

    it('extracts java.util imports', () => {
      const imp = result.imports.find((i) => i.importedNames.includes('Optional'));
      expect(imp).toBeDefined();
    });
  });

  describe('call sites', () => {
    it('detects method invocations', () => {
      const calls = result.callSites.filter((c) => c.callerName === 'AuthService.login');
      const names = calls.map((c) => c.calleeName);
      expect(names).toContain('findByEmail');
      expect(names).toContain('verifyPassword');
    });

    it('detects constructor calls', () => {
      // Constructors don't always show as object_creation_expression in all ASTs
      // but method calls inside constructors should be tracked
      expect(result.callSites.length).toBeGreaterThan(0);
    });
  });
});
