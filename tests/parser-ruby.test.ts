import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getParser, parseSource } from '../src/parser/tree-sitter.js';
import { extractRuby } from '../src/parser/extractors/ruby.js';

const FIXTURE = path.join(__dirname, 'fixtures/sample.rb');

describe('Ruby parser', () => {
  let result: ReturnType<typeof extractRuby>;

  beforeAll(async () => {
    const source = fs.readFileSync(FIXTURE, 'utf-8');
    const parser = await getParser('ruby');
    if (!parser) { console.warn('Ruby WASM not available, skipping'); return; }
    const tree = parseSource(parser, source);
    result = extractRuby(tree, source);
  });

  describe('symbols', () => {
    it('extracts classes', () => {
      const cls = result.symbols.find((s) => s.name === 'User' && s.kind === 'class');
      expect(cls).toBeDefined();
    });

    it('extracts classes with superclass', () => {
      const cls = result.symbols.find((s) => s.name === 'AuthService');
      expect(cls).toBeDefined();
      expect(cls!.signature).toContain('BaseService');
    });

    it('extracts modules', () => {
      const mod = result.symbols.find((s) => s.name === 'Authentication');
      expect(mod).toBeDefined();
    });

    it('extracts public methods', () => {
      const m = result.symbols.find((s) => s.name === 'login');
      expect(m).toBeDefined();
      expect(m!.kind).toBe('method');
      expect(m!.parentName).toBe('AuthService');
      expect(m!.isExported).toBe(true);
    });

    it('extracts private methods', () => {
      const m = result.symbols.find((s) => s.name === 'verify_password');
      expect(m).toBeDefined();
      expect(m!.isExported).toBe(false);
    });

    it('respects visibility state machine', () => {
      const validate = result.symbols.find((s) => s.name === 'validate_email');
      expect(validate).toBeDefined();
      expect(validate!.isExported).toBe(false);
    });

    it('extracts singleton methods', () => {
      const m = result.symbols.find((s) => s.name === 'create');
      expect(m).toBeDefined();
      expect(m!.parentName).toBe('AuthService');
    });

    it('extracts constants', () => {
      const c = result.symbols.find((s) => s.name === 'MAX_RETRIES');
      expect(c).toBeDefined();
      expect(c!.kind).toBe('constant');
    });
  });

  describe('imports', () => {
    it('extracts require', () => {
      const imp = result.imports.find((i) => i.sourcePath === 'json');
      expect(imp).toBeDefined();
    });

    it('extracts require_relative', () => {
      const imp = result.imports.find((i) => i.sourcePath.includes('database'));
      expect(imp).toBeDefined();
    });
  });

  describe('call sites', () => {
    it('detects method calls', () => {
      const calls = result.callSites.filter((c) => c.callerName === 'AuthService.login');
      const names = calls.map((c) => c.calleeName);
      expect(names).toContain('find_by_email');
      expect(names).toContain('verify_password');
    });
  });
});
