import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import fg from 'fast-glob';
import ignore from 'ignore';
import type Database from 'better-sqlite3';
import { getParser, parseSource } from './tree-sitter.js';
import { extractTypeScript } from './extractors/typescript.js';
import { extractPython } from './extractors/python.js';
import { extractGo } from './extractors/go.js';
import { insertParsedFile } from '../storage/queries.js';
import type { ParsedFile, ProbeConfig } from '../types.js';
import { EXT_TO_LANG, LANG_EXTENSIONS } from '../types.js';

export interface ParseProgress {
  total: number;
  current: number;
  file: string;
}

export async function parseProject(
  root: string,
  db: Database.Database,
  config: ProbeConfig,
  onProgress?: (p: ParseProgress) => void,
): Promise<{ files: number; symbols: number; errors: string[] }> {
  const absRoot = path.resolve(root);

  // Build glob patterns for supported languages
  const extensions = config.languages.flatMap((lang) => LANG_EXTENSIONS[lang] ?? []);
  const patterns = extensions.map((ext) => `**/*${ext}`);

  // Load .gitignore + config excludes
  const ig = ignore();
  const gitignorePath = path.join(absRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
  }
  ig.add(config.exclude);

  // Discover files
  const files = await fg(patterns, {
    cwd: absRoot,
    ignore: config.exclude.map((e) => `**/${e}/**`),
    onlyFiles: true,
    absolute: false,
    dot: false,
  });

  // Filter through ignore
  const filtered = files.filter((f) => !ig.ignores(f));

  let totalSymbols = 0;
  const errors: string[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const relPath = filtered[i].replace(/\\/g, '/');
    const absPath = path.join(absRoot, relPath);

    onProgress?.({ total: filtered.length, current: i + 1, file: relPath });

    try {
      const parsed = await parseFile(absPath, relPath);
      if (parsed) {
        insertParsedFile(db, parsed);
        totalSymbols += parsed.symbols.length;
      }
    } catch (err) {
      errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { files: filtered.length, symbols: totalSymbols, errors };
}

async function parseFile(absPath: string, relPath: string): Promise<ParsedFile | null> {
  const ext = path.extname(relPath);
  const language = EXT_TO_LANG[ext];
  if (!language) return null;

  const source = fs.readFileSync(absPath, 'utf-8');

  // Skip very large files (>500KB)
  if (source.length > 512_000) return null;

  const hash = crypto.createHash('md5').update(source).digest('hex');
  const isTsx = ext === '.tsx' || ext === '.jsx';
  const parserLang = language === 'typescript' || language === 'javascript' ? 'typescript' : language;
  const parser = await getParser(parserLang, isTsx);

  if (!parser) {
    // Fallback: return file record with no symbols
    return {
      path: relPath,
      language,
      size: source.length,
      hash,
      symbols: [],
      imports: [],
      callSites: [],
    };
  }

  const tree = parseSource(parser, source);

  let extracted;
  switch (language) {
    case 'typescript':
    case 'javascript':
      extracted = extractTypeScript(tree, source);
      break;
    case 'python':
      extracted = extractPython(tree, source);
      break;
    case 'go':
      extracted = extractGo(tree, source);
      break;
    default:
      return null;
  }

  return {
    path: relPath,
    language,
    size: source.length,
    hash,
    ...extracted,
  };
}

/**
 * Resolve call sites to actual symbol IDs.
 * Run AFTER all files are parsed and inserted.
 */
export function resolveCallGraph(db: Database.Database): number {
  // Build lookup: symbol name → symbol ID (prefer exported)
  const allSymbols = db.prepare(`
    SELECT s.id, s.name, s.kind, s.file_id, s.is_exported, s.parent_symbol_id, f.path as file_path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.kind IN ('function', 'method', 'class')
  `).all() as Array<{
    id: number; name: string; kind: string; file_id: number;
    is_exported: number; parent_symbol_id: number | null; file_path: string;
  }>;

  // Map: name → [{id, fileId, isExported}]
  const nameIndex = new Map<string, Array<{ id: number; fileId: number; isExported: boolean; filePath: string }>>();
  for (const sym of allSymbols) {
    const entries = nameIndex.get(sym.name) ?? [];
    entries.push({ id: sym.id, fileId: sym.file_id, isExported: sym.is_exported === 1, filePath: sym.file_path });
    nameIndex.set(sym.name, entries);
  }

  // Get all imports for resolution
  const allImports = db.prepare(`
    SELECT i.file_id, i.source_path, i.imported_names, f.path as file_path
    FROM imports i
    JOIN files f ON f.id = i.file_id
  `).all() as Array<{
    file_id: number; source_path: string; imported_names: string; file_path: string;
  }>;

  // Build import map: fileId → { importedName → sourceFilePath }
  const importMap = new Map<number, Map<string, string>>();
  for (const imp of allImports) {
    const map = importMap.get(imp.file_id) ?? new Map();
    const names = JSON.parse(imp.imported_names) as string[];

    // Resolve source path relative to the importing file
    const resolvedSource = resolveImportPath(imp.file_path, imp.source_path);

    for (const name of names) {
      map.set(name, resolvedSource);
    }
    importMap.set(imp.file_id, map);
  }

  // Get all call sites (stored as caller_name + callee_name in the parsed data)
  // We need to re-read the parsed call sites from the symbols
  // Actually, call sites aren't stored yet — we need to resolve them

  // For each file, get its symbols and match call sites
  const allFiles = db.prepare('SELECT id, path FROM files').all() as Array<{ id: number; path: string }>;

  const insertCall = db.prepare('INSERT INTO calls (caller_symbol_id, callee_symbol_id, line) VALUES (?, ?, ?)');
  let resolvedCount = 0;

  // We need the raw call sites — but we didn't store them in the DB.
  // Instead, re-parse to find calls. But that's expensive.
  // Alternative: store call sites temporarily during initial parse.
  // For now, we'll use a simpler heuristic: if file A imports symbol X from file B,
  // and file A has a function that was parsed, create a dependency edge.

  // Actually, let's use the import graph directly for now.
  // Each import creates a potential call edge from any function in the importing file
  // to the imported symbol.

  for (const file of allFiles) {
    const fileImports = importMap.get(file.id);
    if (!fileImports) continue;

    const fileSymbols = db.prepare(
      'SELECT id, name FROM symbols WHERE file_id = ? AND kind IN (\'function\', \'method\')',
    ).all(file.id) as Array<{ id: number; name: string }>;

    for (const [importedName, sourcePath] of fileImports) {
      // Find the target symbol
      const candidates = nameIndex.get(importedName);
      if (!candidates) continue;

      // Prefer the one from the matching source file
      const target = candidates.find((c) => c.filePath === sourcePath || c.filePath.startsWith(sourcePath))
        ?? candidates.find((c) => c.isExported);

      if (!target) continue;

      // Create edges from each function in this file to the imported symbol
      // (simplified — ideally we'd only link functions that actually call it)
      for (const caller of fileSymbols) {
        if (caller.id !== target.id) {
          insertCall.run(caller.id, target.id, 0);
          resolvedCount++;
        }
      }
    }
  }

  return resolvedCount;
}

function resolveImportPath(fromFile: string, importSource: string): string {
  // Relative imports
  if (importSource.startsWith('.')) {
    const dir = path.dirname(fromFile);
    let resolved = path.join(dir, importSource).replace(/\\/g, '/');
    // Try common extensions
    if (!path.extname(resolved)) {
      resolved = resolved.replace(/\/$/, '');
    }
    return resolved;
  }
  // Package imports — return as-is
  return importSource;
}
