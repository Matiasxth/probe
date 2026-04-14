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
import { extractRust } from './extractors/rust.js';
import { extractJava } from './extractors/java.js';
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
  incremental: boolean = false,
): Promise<{ files: number; symbols: number; skipped: number; errors: string[] }> {
  const absRoot = path.resolve(root);

  // Build glob patterns for supported languages
  const extensions = config.languages.flatMap((lang) => LANG_EXTENSIONS[lang] ?? []);
  const patterns = extensions.map((ext) => `**/*${ext}`);

  // Comprehensive exclude list — avoid indexing third-party or generated code
  const excludeDirs = [
    ...config.exclude,
    // Package managers
    'node_modules', 'bower_components', 'jspm_packages',
    // Build output
    'dist', 'build', 'out', 'output', '.next', '.nuxt', '.svelte-kit',
    // Caches
    '.cache', '.parcel-cache', '.turbo', '.eslintcache',
    // VCS
    '.git', '.svn', '.hg',
    // Python
    '__pycache__', '.venv', 'venv', 'env', '.eggs', '*.egg-info',
    'site-packages', '.mypy_cache', '.pytest_cache', '.tox',
    // Go
    'vendor',
    // IDE
    '.idea', '.vscode',
    // Tool dirs
    '.probe', 'coverage', '.nyc_output',
    // Common non-source dirs
    'benchmarks', 'benchmark', 'fixtures', 'third_party', 'third-party',
    'external', 'deps',
  ];

  // Load .gitignore + .probeignore + config excludes
  const ig = ignore();
  const gitignorePath = path.join(absRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
  }
  const probeignorePath = path.join(absRoot, '.probeignore');
  if (fs.existsSync(probeignorePath)) {
    ig.add(fs.readFileSync(probeignorePath, 'utf-8'));
  }
  ig.add(excludeDirs);

  // Discover files
  const ignoreGlobs = excludeDirs.map((e) => `**/${e}/**`);
  const files = await fg(patterns, {
    cwd: absRoot,
    ignore: ignoreGlobs,
    onlyFiles: true,
    absolute: false,
    dot: false,
  });

  // Additional filter: skip files inside directories containing their own package.json
  // (nested projects like benchmarks/repos/**)
  const nestedProjectDirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    // Check if any parent (excluding root) has a package.json/go.mod/setup.py
    for (let i = 1; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/');
      if (nestedProjectDirs.has(dir)) continue;
      const markerFiles = ['package.json', 'go.mod', 'setup.py', 'pyproject.toml', 'Cargo.toml'];
      for (const marker of markerFiles) {
        const markerPath = path.join(absRoot, dir, marker);
        if (fs.existsSync(markerPath)) {
          nestedProjectDirs.add(dir);
          break;
        }
      }
    }
  }

  // Filter through ignore + nested project detection
  const filtered = files.filter((f) => {
    if (ig.ignores(f)) return false;
    // Skip files in nested projects
    for (const dir of nestedProjectDirs) {
      if (f.startsWith(dir + '/')) return false;
    }
    return true;
  });

  // Incremental: check existing file hashes
  const existingHashes = new Map<string, string>();
  if (incremental) {
    const rows = db.prepare('SELECT path, hash FROM files').all() as Array<{ path: string; hash: string }>;
    for (const row of rows) existingHashes.set(row.path, row.hash);
  }

  let totalSymbols = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const relPath = filtered[i].replace(/\\/g, '/');
    const absPath = path.join(absRoot, relPath);

    onProgress?.({ total: filtered.length, current: i + 1, file: relPath });

    try {
      // Quick hash check for incremental mode
      if (incremental && existingHashes.has(relPath)) {
        const currentHash = crypto.createHash('md5').update(fs.readFileSync(absPath, 'utf-8')).digest('hex');
        if (currentHash === existingHashes.get(relPath)) {
          // Count existing symbols
          const count = (db.prepare('SELECT COUNT(*) as c FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ?').get(relPath) as any)?.c ?? 0;
          totalSymbols += count;
          skipped++;
          continue;
        }
        // File changed — delete old data and re-parse
        const oldFile = db.prepare('SELECT id FROM files WHERE path = ?').get(relPath) as { id: number } | undefined;
        if (oldFile) {
          db.prepare('DELETE FROM call_sites WHERE file_id = ?').run(oldFile.id);
          db.prepare('DELETE FROM imports WHERE file_id = ?').run(oldFile.id);
          db.prepare('DELETE FROM symbols WHERE file_id = ?').run(oldFile.id);
          db.prepare('DELETE FROM files WHERE id = ?').run(oldFile.id);
        }
      }

      const parsed = await parseFile(absPath, relPath);
      if (parsed) {
        insertParsedFile(db, parsed);
        totalSymbols += parsed.symbols.length;
      }
    } catch (err) {
      errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Remove files that no longer exist on disk
  if (incremental) {
    const filteredSet = new Set(filtered.map((f) => f.replace(/\\/g, '/')));
    for (const [existingPath] of existingHashes) {
      if (!filteredSet.has(existingPath)) {
        const oldFile = db.prepare('SELECT id FROM files WHERE path = ?').get(existingPath) as { id: number } | undefined;
        if (oldFile) {
          db.prepare('DELETE FROM files WHERE id = ?').run(oldFile.id);
        }
      }
    }
  }

  return { files: filtered.length, symbols: totalSymbols, skipped, errors };
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
      extracted = extractTypeScript(tree, source, isTsx);
      break;
    case 'python':
      extracted = extractPython(tree, source);
      break;
    case 'go':
      extracted = extractGo(tree, source);
      break;
    case 'rust':
      extracted = extractRust(tree, source);
      break;
    case 'java':
      extracted = extractJava(tree, source);
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
 * Resolve raw call_sites to actual symbol-to-symbol edges in the calls table.
 * Uses stored call sites (caller_name + callee_name) from AST parsing,
 * combined with the import graph to resolve callee identity.
 */
export function resolveCallGraph(db: Database.Database, root?: string): number {
  // Load path aliases for TS resolution and Go module path
  if (root) {
    loadPathAliases(root);
    loadGoModulePath(root);
  }

  // 1. Build symbol lookup: name → [{id, fileId, isExported, filePath}]
  const allSymbols = db.prepare(`
    SELECT s.id, s.name, s.kind, s.file_id, s.is_exported, f.path as file_path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.kind IN ('function', 'method', 'class', 'variable', 'constant')
  `).all() as Array<{
    id: number; name: string; kind: string; file_id: number;
    is_exported: number; file_path: string;
  }>;

  const nameIndex = new Map<string, Array<{ id: number; fileId: number; isExported: boolean; filePath: string }>>();
  for (const sym of allSymbols) {
    const entries = nameIndex.get(sym.name) ?? [];
    entries.push({ id: sym.id, fileId: sym.file_id, isExported: sym.is_exported === 1, filePath: sym.file_path });
    nameIndex.set(sym.name, entries);
  }

  // 2. Build per-file symbol map: fileId → {name → symbolId}
  const fileSymbolMap = new Map<number, Map<string, number>>();
  for (const sym of allSymbols) {
    const map = fileSymbolMap.get(sym.file_id) ?? new Map();
    map.set(sym.name, sym.id);
    fileSymbolMap.set(sym.file_id, map);
  }

  // 3. Build import resolution: fileId → {importedName → resolved source path}
  const allImports = db.prepare(`
    SELECT i.file_id, i.source_path, i.imported_names, i.original_names, f.path as file_path
    FROM imports i
    JOIN files f ON f.id = i.file_id
  `).all() as Array<{
    file_id: number; source_path: string; imported_names: string; original_names: string; file_path: string;
  }>;

  // importMap: fileId → { localName → resolvedSourcePath }
  const importMap = new Map<number, Map<string, string>>();
  // aliasMap: fileId → { localName → originalName } (only for aliased imports)
  const aliasMap = new Map<number, Map<string, string>>();

  for (const imp of allImports) {
    const map = importMap.get(imp.file_id) ?? new Map();
    const names = JSON.parse(imp.imported_names) as string[];
    const origNames = JSON.parse(imp.original_names || '{}') as Record<string, string>;
    const resolvedSource = resolveImportPath(imp.file_path, imp.source_path);

    for (const name of names) {
      map.set(name, resolvedSource);
    }
    importMap.set(imp.file_id, map);

    // Store alias mappings
    if (Object.keys(origNames).length > 0) {
      const aMap = aliasMap.get(imp.file_id) ?? new Map();
      for (const [alias, original] of Object.entries(origNames)) {
        aMap.set(alias, original);
      }
      aliasMap.set(imp.file_id, aMap);
    }
  }

  // 3b. Build re-export graph for barrel exports (export * from './sub')
  // Maps: source file path → [re-exported source paths]
  const reExportGraph = new Map<string, string[]>();
  const allNamespaceReExports = db.prepare(`
    SELECT i.source_path, f.path as file_path
    FROM imports i
    JOIN files f ON f.id = i.file_id
    WHERE i.is_namespace = 1 AND i.imported_names = '[]'
  `).all() as Array<{ source_path: string; file_path: string }>;

  for (const re of allNamespaceReExports) {
    const resolvedTarget = resolveImportPath(re.file_path, re.source_path);
    const existing = reExportGraph.get(re.file_path) ?? [];
    existing.push(resolvedTarget);
    reExportGraph.set(re.file_path, existing);
  }

  // Follow re-export chains: if A re-exports from B, and B re-exports from C,
  // then symbols from C are also available via A
  function getReExportChain(filePath: string, visited = new Set<string>()): string[] {
    if (visited.has(filePath)) return []; // cycle
    visited.add(filePath);
    const direct = reExportGraph.get(filePath) ?? [];
    const all = [...direct];
    for (const d of direct) {
      // Also check files matching this path
      for (const [fp, targets] of reExportGraph) {
        if (fp.replace(/\.[^.]+$/, '') === d || fp.startsWith(d + '/')) {
          all.push(...getReExportChain(fp, visited));
        }
      }
    }
    return all;
  }

  // 4. Read all raw call sites from staging table
  const rawCallSites = db.prepare(`
    SELECT cs.file_id, cs.caller_name, cs.callee_name, cs.line
    FROM call_sites cs
  `).all() as Array<{
    file_id: number; caller_name: string; callee_name: string; line: number;
  }>;

  // 5. Resolve each call site to symbol IDs
  const insertCall = db.prepare('INSERT INTO calls (caller_symbol_id, callee_symbol_id, line) VALUES (?, ?, ?)');
  const seen = new Set<string>(); // deduplicate
  let resolvedCount = 0;

  const resolveTx = db.transaction(() => {
    for (const cs of rawCallSites) {
      // Resolve caller: find symbol named cs.caller_name in the same file
      const fileSymbols = fileSymbolMap.get(cs.file_id);
      if (!fileSymbols) continue;

      // Try full name (e.g., "Hono.dispatch") then just method name (e.g., "dispatch")
      let callerId = fileSymbols.get(cs.caller_name);
      if (!callerId && cs.caller_name.includes('.')) {
        const methodName = cs.caller_name.split('.').pop()!;
        callerId = fileSymbols.get(methodName);
      }
      if (!callerId) continue;

      // Resolve callee: check in order:
      // a) Same file (local call)
      // b) Imported symbol (follow import graph)
      // c) Global match (exported symbol with that name)
      let calleeId: number | undefined;

      // a) Same file
      calleeId = fileSymbols.get(cs.callee_name);

      // b) Import resolution
      if (!calleeId) {
        const fileImports = importMap.get(cs.file_id);
        if (fileImports) {
          const sourcePath = fileImports.get(cs.callee_name);
          if (sourcePath) {
            // Check if this name is an alias — use original name for target lookup
            const fileAliases = aliasMap.get(cs.file_id);
            const targetName = fileAliases?.get(cs.callee_name) ?? cs.callee_name;

            const candidates = nameIndex.get(targetName);
            if (candidates) {
              // Direct match in source file
              let match = candidates.find((c) =>
                c.filePath === sourcePath ||
                c.filePath.startsWith(sourcePath + '/') ||
                c.filePath.replace(/\.[^.]+$/, '') === sourcePath ||
                c.filePath.replace(/\.[^.]+$/, '').endsWith('/' + sourcePath.split('/').pop()),
              );

              // If not found, check re-export chain from the source file
              if (!match) {
                const reExports = getReExportChain(sourcePath);
                for (const reTarget of reExports) {
                  match = candidates.find((c) =>
                    c.filePath === reTarget ||
                    c.filePath.startsWith(reTarget + '/') ||
                    c.filePath.replace(/\.[^.]+$/, '') === reTarget ||
                    c.filePath.replace(/\.[^.]+$/, '').endsWith('/' + reTarget.split('/').pop()),
                  );
                  if (match) break;
                }
              }

              if (match) calleeId = match.id;
            }
          }
        }
      }

      // c) Global: any exported symbol with this name (try alias→original too)
      if (!calleeId) {
        const fileAliases = aliasMap.get(cs.file_id);
        const targetName = fileAliases?.get(cs.callee_name) ?? cs.callee_name;
        const candidates = nameIndex.get(targetName) ?? nameIndex.get(cs.callee_name);
        if (candidates) {
          const exported = candidates.find((c) => c.isExported && c.fileId !== cs.file_id);
          if (exported) calleeId = exported.id;
        }
      }

      if (!calleeId || calleeId === callerId) continue;

      const key = `${callerId}:${calleeId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      insertCall.run(callerId, calleeId, cs.line);
      resolvedCount++;
    }
  });

  resolveTx();

  return resolvedCount;
}

// Cache for tsconfig path aliases and Go module path
let pathAliases: Array<{ prefix: string; targets: string[] }> | null = null;
let goModulePath: string | null = null;
let goModuleLoaded = false;

function loadPathAliases(root: string): void {
  if (pathAliases !== null) return;
  pathAliases = [];

  const tsconfigPath = path.join(root, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return;

  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf-8');
    // Strip comments (// and /* */) for JSON parsing
    const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const tsconfig = JSON.parse(cleaned);
    const paths = tsconfig.compilerOptions?.paths;
    if (!paths) return;

    const baseUrl = tsconfig.compilerOptions?.baseUrl ?? '.';

    for (const [pattern, targets] of Object.entries(paths)) {
      // "@/*" → prefix "@/", targets ["./src/*"] → ["src/"]
      const prefix = pattern.replace('*', '');
      const resolvedTargets = (targets as string[]).map((t) =>
        path.join(baseUrl, t.replace('*', '')).replace(/\\/g, '/'),
      );
      pathAliases.push({ prefix, targets: resolvedTargets });
    }
  } catch {
    // Ignore parse errors
  }
}

function loadGoModulePath(root: string): void {
  if (goModuleLoaded) return;
  goModuleLoaded = true;

  const goModPath = path.join(root, 'go.mod');
  if (!fs.existsSync(goModPath)) return;

  try {
    const content = fs.readFileSync(goModPath, 'utf-8');
    const match = content.match(/^module\s+(\S+)/m);
    if (match) {
      goModulePath = match[1];
    }
  } catch {
    // Ignore
  }
}

function resolveImportPath(fromFile: string, importSource: string): string {
  // Relative imports
  if (importSource.startsWith('.')) {
    const dir = path.dirname(fromFile);
    let resolved = path.join(dir, importSource).replace(/\\/g, '/');
    if (!path.extname(resolved)) {
      resolved = resolved.replace(/\/$/, '');
    }
    return resolved;
  }

  // Path alias resolution (e.g., @/utils → src/utils)
  if (pathAliases) {
    for (const alias of pathAliases) {
      if (importSource.startsWith(alias.prefix)) {
        const rest = importSource.slice(alias.prefix.length);
        // Return the first target match
        return (alias.targets[0] + rest).replace(/\\/g, '/');
      }
    }
  }

  // Go module resolution: strip module prefix to get relative path
  if (goModulePath && importSource.startsWith(goModulePath + '/')) {
    return importSource.slice(goModulePath.length + 1);
  }

  // Package imports — return as-is
  return importSource;
}
