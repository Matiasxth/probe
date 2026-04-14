import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getParser, parseSource } from '../src/parser/tree-sitter.js';
import { extractPython } from '../src/parser/extractors/python.js';

const FIXTURE = path.join(__dirname, 'fixtures/sample.py');

describe('Python parser', () => {
  let result: ReturnType<typeof extractPython>;

  beforeAll(async () => {
    const source = fs.readFileSync(FIXTURE, 'utf-8');
    const parser = await getParser('python');
    expect(parser).toBeTruthy();
    const tree = parseSource(parser!, source);
    result = extractPython(tree, source);
  });

  describe('symbols', () => {
    it('extracts classes', () => {
      const cls = result.symbols.find((s) => s.name === 'UserService');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
      expect(cls!.isExported).toBe(true);
    });

    it('extracts methods with parent', () => {
      const method = result.symbols.find((s) => s.name === 'find_by_email');
      expect(method).toBeDefined();
      expect(method!.kind).toBe('method');
      expect(method!.parentName).toBe('UserService');
    });

    it('extracts top-level functions', () => {
      const fn = result.symbols.find((s) => s.name === 'authenticate');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
      expect(fn!.isExported).toBe(true);
    });

    it('marks private functions as non-exported', () => {
      const fn = result.symbols.find((s) => s.name === '_verify_password');
      expect(fn).toBeDefined();
      expect(fn!.isExported).toBe(false);
    });

    it('extracts constants', () => {
      const c = result.symbols.find((s) => s.name === 'MAX_RETRIES');
      expect(c).toBeDefined();
      expect(c!.kind).toBe('constant');
    });

    it('captures docstrings', () => {
      const cls = result.symbols.find((s) => s.name === 'UserService');
      expect(cls!.docComment).toContain('Service for user management');
    });

    it('captures method signatures with types', () => {
      const method = result.symbols.find((s) => s.name === 'find_by_email');
      expect(method!.signature).toContain('email: str');
      expect(method!.signature).toContain('Optional[User]');
    });
  });

  describe('imports', () => {
    it('extracts from imports', () => {
      const imp = result.imports.find((i) => i.sourcePath === 'typing');
      expect(imp).toBeDefined();
      expect(imp!.importedNames).toContain('Optional');
    });

    it('extracts relative imports', () => {
      const imp = result.imports.find((i) => i.sourcePath === '.models');
      expect(imp).toBeDefined();
      expect(imp!.importedNames).toContain('User');
    });
  });

  describe('call sites', () => {
    it('detects function calls', () => {
      const calls = result.callSites.filter((c) => c.callerName === 'authenticate');
      const names = calls.map((c) => c.calleeName);
      expect(names).toContain('find_by_email');
      expect(names).toContain('_verify_password');
    });

    it('detects calls inside methods', () => {
      const calls = result.callSites.filter((c) => c.callerName === 'UserService.find_by_email');
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});
