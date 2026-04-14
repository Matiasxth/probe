import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getParser, parseSource } from '../src/parser/tree-sitter.js';
import { extractRust } from '../src/parser/extractors/rust.js';

const FIXTURE = path.join(__dirname, 'fixtures/sample.rs');

describe('Rust parser', () => {
  let result: ReturnType<typeof extractRust>;

  beforeAll(async () => {
    const source = fs.readFileSync(FIXTURE, 'utf-8');
    const parser = await getParser('rust');
    expect(parser).toBeTruthy();
    const tree = parseSource(parser!, source);
    result = extractRust(tree, source);
  });

  describe('symbols', () => {
    it('extracts pub functions', () => {
      const fn = result.symbols.find((s) => s.name === 'new' && s.parentName === 'AuthService');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('method');
      expect(fn!.isExported).toBe(true);
    });

    it('extracts private functions', () => {
      const fn = result.symbols.find((s) => s.name === 'verify_password');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
      expect(fn!.isExported).toBe(false);
    });

    it('extracts structs as class', () => {
      const s = result.symbols.find((s) => s.name === 'User');
      expect(s).toBeDefined();
      expect(s!.kind).toBe('class');
      expect(s!.isExported).toBe(true);
    });

    it('extracts enums', () => {
      const e = result.symbols.find((s) => s.name === 'Role');
      expect(e).toBeDefined();
      expect(e!.kind).toBe('enum');
    });

    it('extracts traits as interface', () => {
      const t = result.symbols.find((s) => s.name === 'Authenticator');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('interface');
    });

    it('extracts type aliases', () => {
      const t = result.symbols.find((s) => s.name === 'AuthResult');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('type');
    });

    it('extracts constants', () => {
      const c = result.symbols.find((s) => s.name === 'MAX_RETRIES');
      expect(c).toBeDefined();
      expect(c!.kind).toBe('constant');
    });

    it('extracts methods inside impl blocks with parent', () => {
      const m = result.symbols.find((s) => s.name === 'login');
      expect(m).toBeDefined();
      expect(m!.kind).toBe('method');
      expect(m!.parentName).toBe('AuthService');
    });

    it('extracts methods inside impl for struct', () => {
      const m = result.symbols.find((s) => s.name === 'is_admin');
      expect(m).toBeDefined();
      expect(m!.parentName).toBe('User');
    });

    it('captures doc comments', () => {
      const s = result.symbols.find((s) => s.name === 'User');
      expect(s!.docComment).toContain('Represents a user');
    });
  });

  describe('imports', () => {
    it('extracts use declarations', () => {
      const imp = result.imports.find((i) => i.importedNames.includes('HashMap'));
      expect(imp).toBeDefined();
    });

    it('extracts crate:: imports', () => {
      const imp = result.imports.find((i) => i.importedNames.includes('Database'));
      expect(imp).toBeDefined();
      expect(imp!.sourcePath).not.toContain('crate::');
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
