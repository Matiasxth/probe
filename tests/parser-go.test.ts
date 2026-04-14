import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getParser, parseSource } from '../src/parser/tree-sitter.js';
import { extractGo } from '../src/parser/extractors/go.js';

const FIXTURE = path.join(__dirname, 'fixtures/sample.go');

describe('Go parser', () => {
  let result: ReturnType<typeof extractGo>;

  beforeAll(async () => {
    const source = fs.readFileSync(FIXTURE, 'utf-8');
    const parser = await getParser('go');
    expect(parser).toBeTruthy();
    const tree = parseSource(parser!, source);
    result = extractGo(tree, source);
  });

  describe('symbols', () => {
    it('extracts functions', () => {
      const fn = result.symbols.find((s) => s.name === 'NewAuthService');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
      expect(fn!.isExported).toBe(true);
    });

    it('extracts unexported functions', () => {
      const fn = result.symbols.find((s) => s.name === 'verifyPassword');
      expect(fn).toBeDefined();
      expect(fn!.isExported).toBe(false);
    });

    it('extracts methods with receiver', () => {
      const method = result.symbols.find((s) => s.name === 'Authenticate');
      expect(method).toBeDefined();
      expect(method!.kind).toBe('method');
      expect(method!.parentName).toBe('AuthService');
    });

    it('extracts structs as class', () => {
      const st = result.symbols.find((s) => s.name === 'User');
      expect(st).toBeDefined();
      expect(st!.kind).toBe('class');
      expect(st!.isExported).toBe(true);
    });

    it('extracts interfaces', () => {
      const iface = result.symbols.find((s) => s.name === 'Database');
      expect(iface).toBeDefined();
      expect(iface!.kind).toBe('interface');
    });

    it('extracts constants', () => {
      const c = result.symbols.find((s) => s.name === 'MaxRetries');
      expect(c).toBeDefined();
      expect(c!.kind).toBe('constant');
      expect(c!.isExported).toBe(true);
    });

    it('extracts type aliases', () => {
      const t = result.symbols.find((s) => s.name === 'Role');
      expect(t).toBeDefined();
    });

    it('captures doc comments', () => {
      const fn = result.symbols.find((s) => s.name === 'Authenticate');
      expect(fn!.docComment).toContain('Authenticate verifies');
    });
  });

  describe('imports', () => {
    it('extracts imports', () => {
      expect(result.imports.length).toBeGreaterThan(0);
      const fmtImport = result.imports.find((i) => i.sourcePath === 'fmt');
      expect(fmtImport).toBeDefined();
    });
  });

  describe('call sites', () => {
    it('detects function calls in methods', () => {
      const calls = result.callSites.filter((c) => c.callerName === 'AuthService.Authenticate');
      const names = calls.map((c) => c.calleeName);
      expect(names).toContain('FindByEmail');
      expect(names).toContain('verifyPassword');
    });
  });
});
