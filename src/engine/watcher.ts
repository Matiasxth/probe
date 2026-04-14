import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { DEFAULT_CONFIG, EXT_TO_LANG, LANG_EXTENSIONS } from '../types.js';
import { parseProject, resolveCallGraph } from '../parser/index.js';
import { resolveMethodCalls } from '../parser/type-resolver.js';
import { extractPatterns } from '../analysis/patterns.js';
import { setMeta } from '../storage/database.js';

const DEBOUNCE_MS = 2000;
const SUPPORTED_EXTENSIONS = new Set(
  Object.values(LANG_EXTENSIONS).flat(),
);

export function startWatcher(root: string, db: Database.Database): { close: () => void } {
  const absRoot = path.resolve(root);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const changedFiles = new Set<string>();

  const watcher = chokidar.watch(absRoot, {
    ignored: [
      '**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**',
      '**/.probe/**', '**/coverage/**', '**/__pycache__/**', '**/vendor/**',
      '**/.venv/**', '**/.next/**',
    ],
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 2000,
  });

  function scheduleReindex() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (changedFiles.size === 0) return;

      const files = [...changedFiles];
      changedFiles.clear();

      try {
        // Delete old data for changed files
        for (const relPath of files) {
          const normalized = relPath.replace(/\\/g, '/');
          const oldFile = db.prepare('SELECT id FROM files WHERE path = ?').get(normalized) as { id: number } | undefined;
          if (oldFile) {
            db.prepare('DELETE FROM call_sites WHERE file_id = ?').run(oldFile.id);
            db.prepare('DELETE FROM imports WHERE file_id = ?').run(oldFile.id);
            db.prepare('DELETE FROM symbols WHERE file_id = ?').run(oldFile.id);
            db.prepare('DELETE FROM files WHERE id = ?').run(oldFile.id);
          }
        }

        // Re-run full incremental index
        db.exec('DELETE FROM calls; DELETE FROM co_changes; DELETE FROM patterns;');

        await parseProject(absRoot, db, DEFAULT_CONFIG, undefined, true);
        resolveCallGraph(db);
        resolveMethodCalls(db);
        extractPatterns(db);
        setMeta(db, 'indexed_at', new Date().toISOString());

        process.stderr.write(`[probe] Auto-reindexed ${files.length} changed file(s)\n`);
      } catch (err) {
        process.stderr.write(`[probe] Reindex error: ${err}\n`);
      }
    }, DEBOUNCE_MS);
  }

  function isRelevantFile(filePath: string): boolean {
    const ext = path.extname(filePath);
    return SUPPORTED_EXTENSIONS.has(ext);
  }

  watcher.on('change', (filePath) => {
    if (!isRelevantFile(filePath)) return;
    const rel = path.relative(absRoot, filePath).replace(/\\/g, '/');
    changedFiles.add(rel);
    scheduleReindex();
  });

  watcher.on('add', (filePath) => {
    if (!isRelevantFile(filePath)) return;
    const rel = path.relative(absRoot, filePath).replace(/\\/g, '/');
    changedFiles.add(rel);
    scheduleReindex();
  });

  watcher.on('unlink', (filePath) => {
    if (!isRelevantFile(filePath)) return;
    const normalized = path.relative(absRoot, filePath).replace(/\\/g, '/');
    const oldFile = db.prepare('SELECT id FROM files WHERE path = ?').get(normalized) as { id: number } | undefined;
    if (oldFile) {
      db.prepare('DELETE FROM files WHERE id = ?').run(oldFile.id);
      // Schedule re-resolution of call graph
      changedFiles.add('__deleted__');
      scheduleReindex();
    }
  });

  return {
    close: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    },
  };
}
