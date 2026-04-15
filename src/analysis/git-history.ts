import simpleGit from 'simple-git';
import type Database from 'better-sqlite3';
import { insertCoChange } from '../storage/queries.js';
import type { ProbeConfig } from '../types.js';

interface CommitFiles {
  hash: string;
  files: string[];
}

export async function analyzeGitHistory(
  root: string,
  db: Database.Database,
  config: ProbeConfig,
): Promise<number> {
  const git = simpleGit(root);

  // Check if it's a git repo
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) return 0;

  // Detect shallow clone
  const isShallow = await git.raw(['rev-parse', '--is-shallow-repository']).catch(() => 'false');
  if (isShallow.trim() === 'true') {
    process.stderr.write('[probe] Shallow clone detected — co-change analysis may be limited.\n');
    process.stderr.write('[probe] Run `git fetch --deepen=500` for better results.\n');
  }

  // Get recent commits with changed files
  const log = await git.log({
    maxCount: config.gitHistory.maxCommits,
    '--name-only': null,
    '--diff-filter': 'ACDMR',
  });

  // Get indexed files for filtering
  const indexedFiles = new Set(
    (db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((r) => r.path),
  );

  // Parse commits → files
  const commits: CommitFiles[] = [];
  for (const entry of log.all) {
    const files = (entry.diff?.files.map((f) => f.file) ?? [])
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => indexedFiles.has(f));

    if (files.length > 0 && files.length <= config.gitHistory.maxFilesPerCommit) {
      commits.push({ hash: entry.hash, files });
    }
  }

  // Compute co-change matrix
  const coChangeMap = new Map<string, { count: number; commits: number }>();
  const fileCommitCount = new Map<string, number>();

  for (const commit of commits) {
    for (const file of commit.files) {
      fileCommitCount.set(file, (fileCommitCount.get(file) ?? 0) + 1);
    }

    // All pairs in this commit
    for (let i = 0; i < commit.files.length; i++) {
      for (let j = i + 1; j < commit.files.length; j++) {
        const key = [commit.files[i], commit.files[j]].sort().join('\0');
        const entry = coChangeMap.get(key) ?? { count: 0, commits: commits.length };
        entry.count++;
        coChangeMap.set(key, entry);
      }
    }
  }

  // Store co-changes above threshold
  let stored = 0;
  const totalCommits = commits.length;

  for (const [key, { count }] of coChangeMap) {
    const [fileA, fileB] = key.split('\0');
    const maxFileCommits = Math.max(
      fileCommitCount.get(fileA) ?? 1,
      fileCommitCount.get(fileB) ?? 1,
    );
    const confidence = count / maxFileCommits;

    if (confidence >= config.gitHistory.minCoChangeConfidence && count >= 2) {
      insertCoChange(db, fileA, fileB, count, totalCommits, Math.round(confidence * 100) / 100);
      stored++;
    }
  }

  // Fallback: if no co-changes from git, use file proximity heuristic
  if (stored === 0) {
    stored = addProximityCoChanges(db, config);
  }

  return stored;
}

/**
 * When git history is unavailable, infer co-changes from file proximity:
 * files in the same directory with similar base names likely co-change.
 * e.g., auth_service.py ↔ auth_controller.py, user.model.ts ↔ user.service.ts
 */
function addProximityCoChanges(db: Database.Database, config: ProbeConfig): number {
  const files = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;

  // Group files by directory
  const dirFiles = new Map<string, string[]>();
  for (const f of files) {
    const dir = f.path.split('/').slice(0, -1).join('/');
    const list = dirFiles.get(dir) ?? [];
    list.push(f.path);
    dirFiles.set(dir, list);
  }

  let stored = 0;
  for (const [_dir, paths] of dirFiles) {
    if (paths.length < 2 || paths.length > 15) continue;

    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const nameA = paths[i].split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
        const nameB = paths[j].split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();

        // Check name similarity: shared prefix or common base
        const partsA = nameA.split(/[._-]/);
        const partsB = nameB.split(/[._-]/);
        const shared = partsA.filter((p) => partsB.includes(p) && p.length > 2);

        if (shared.length > 0) {
          insertCoChange(db, paths[i], paths[j], 1, 1, 0.3);
          stored++;
        }
      }
    }
  }

  return stored;
}

export async function getLastChanged(root: string, filePath: string): Promise<string | null> {
  try {
    const git = simpleGit(root);
    const log = await git.log({ maxCount: 1, file: filePath });
    return log.latest?.date ?? null;
  } catch {
    return null;
  }
}
