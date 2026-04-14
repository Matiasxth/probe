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

    if (files.length > 0 && files.length <= 20) {
      // Skip huge commits (merges, bulk changes)
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
