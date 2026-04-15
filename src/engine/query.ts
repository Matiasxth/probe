import type Database from 'better-sqlite3';
import type { QueryMatch, SymbolKind } from '../types.js';
import { searchSymbols, getCallers, getCallees, getCoChanges, getFileByPath } from '../storage/queries.js';
import { expandKeywords, composeCompoundIdentifiers } from './concepts.js';

interface QueryOptions {
  limit: number;
}

export function queryCodebase(db: Database.Database, task: string, opts: QueryOptions = { limit: 15 }): QueryMatch[] {
  const rawKeywords = extractKeywords(task);
  const compoundIds = composeCompoundIdentifiers(rawKeywords);
  const keywords = [...compoundIds, ...expandKeywords(rawKeywords)];
  if (keywords.length === 0) return [];

  const resultMap = new Map<string, QueryMatch>();

  const rawSet = new Set([...rawKeywords, ...compoundIds].map((k) => k.toLowerCase()));

  // === Pass 1: Direct symbol name matches ===
  for (const keyword of keywords) {
    const matches = searchSymbols(db, keyword);
    const isOriginal = rawSet.has(keyword.toLowerCase());

    for (const sym of matches) {
      const key = `${sym.file_path}:${sym.name}`;
      const existing = resultMap.get(key);
      let relevance = computeRelevance(sym.name, keyword, sym.is_exported === 1);

      // Synonym matches get lower relevance than direct keyword matches
      if (!isOriginal) {
        relevance = Math.max(relevance - 15, 20);
      }

      const reason = isOriginal
        ? `Match: "${keyword}" in ${sym.kind} name`
        : `Semantic match: "${keyword}" (synonym) in ${sym.kind} name`;

      if (!existing || existing.relevance < relevance) {
        resultMap.set(key, {
          file: sym.file_path ?? '',
          symbol: sym.name,
          kind: sym.kind as SymbolKind,
          line: sym.line_start,
          signature: sym.signature,
          reason,
          relevance,
          calls: [],
          calledBy: [],
          lastChanged: null,
        });
      }
    }
  }

  // === Pass 2: File path matches ===
  for (const keyword of keywords) {
    const isOriginal = rawSet.has(keyword.toLowerCase());
    const files = db.prepare(`
      SELECT f.*, COUNT(s.id) as symbol_count
      FROM files f
      LEFT JOIN symbols s ON s.file_id = f.id
      WHERE f.path LIKE ?
      GROUP BY f.id
      LIMIT 10
    `).all(`%${keyword}%`) as Array<{ id: number; path: string; language: string; symbol_count: number }>;

    for (const file of files) {
      const key = `${file.path}:__file__`;
      if (!resultMap.has(key)) {
        // Dynamic path relevance based on match quality
        const segments = file.path.split('/');
        const fileName = segments[segments.length - 1].replace(/\.[^.]+$/, '');
        const dirSegments = segments.slice(0, -1);
        const kw = keyword.toLowerCase();

        let pathRelevance: number;
        if (fileName.toLowerCase() === kw) pathRelevance = 85;
        else if (dirSegments.some((seg) => seg.toLowerCase() === kw)) pathRelevance = 80;
        else if (fileName.toLowerCase().includes(kw)) pathRelevance = 75;
        else pathRelevance = isOriginal ? 50 : 35;

        if (!isOriginal && pathRelevance > 35) pathRelevance -= 10;

        resultMap.set(key, {
          file: file.path,
          symbol: null,
          kind: null,
          line: null,
          signature: null,
          reason: isOriginal ? `File path matches "${keyword}"` : `File path matches "${keyword}" (synonym)`,
          relevance: pathRelevance + (file.symbol_count > 0 ? 5 : 0),
          calls: [],
          calledBy: [],
          lastChanged: null,
        });
      }
    }
  }

  // === Pass 3: Expand via call graph ===
  const directMatches = [...resultMap.values()].filter((m) => m.relevance >= 60);
  for (const match of directMatches) {
    if (!match.symbol || !match.line) continue;

    // Find the symbol ID
    const sym = db.prepare(`
      SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.name = ? AND f.path = ?
    `).get(match.symbol, match.file) as { id: number } | undefined;

    if (!sym) continue;

    // Who calls this?
    const callers = getCallers(db, sym.id);
    for (const caller of callers.slice(0, 5)) {
      match.calledBy.push(`${caller.file_path}:${caller.name}`);

      const key = `${caller.file_path}:${caller.name}`;
      if (!resultMap.has(key)) {
        resultMap.set(key, {
          file: caller.file_path ?? '',
          symbol: caller.name,
          kind: caller.kind as SymbolKind,
          line: caller.line_start,
          signature: caller.signature,
          reason: `Calls ${match.symbol}`,
          relevance: 40,
          calls: [match.symbol],
          calledBy: [],
          lastChanged: null,
        });
      }
    }

    // Who does this call?
    const callees = getCallees(db, sym.id);
    for (const callee of callees.slice(0, 5)) {
      match.calls.push(`${callee.file_path}:${callee.name}`);

      const key = `${callee.file_path}:${callee.name}`;
      if (!resultMap.has(key)) {
        resultMap.set(key, {
          file: callee.file_path ?? '',
          symbol: callee.name,
          kind: callee.kind as SymbolKind,
          line: callee.line_start,
          signature: callee.signature,
          reason: `Called by ${match.symbol}`,
          relevance: 35,
          calls: [],
          calledBy: [match.symbol],
          lastChanged: null,
        });
      }
    }
  }

  // === Pass 4: Co-change correlation ===
  const topFiles = new Set(
    [...resultMap.values()]
      .filter((m) => m.relevance >= 50)
      .map((m) => m.file),
  );

  for (const filePath of topFiles) {
    const coChanges = getCoChanges(db, filePath);
    for (const cc of coChanges.slice(0, 3)) {
      const key = `${cc.file}:__cochange__`;
      if (!resultMap.has(key)) {
        resultMap.set(key, {
          file: cc.file,
          symbol: null,
          kind: null,
          line: null,
          signature: null,
          reason: `Co-changes with ${filePath} (${Math.round(cc.confidence * 100)}% correlation)`,
          relevance: 20 + Math.round(cc.confidence * 20),
          calls: [],
          calledBy: [],
          lastChanged: null,
        });
      }
    }
  }

  // === Pass 5: Test file detection ===
  for (const match of [...resultMap.values()]) {
    if (match.relevance < 50) continue;
    const baseName = match.file.replace(/\.[^.]+$/, '');

    // Look for test files
    const testPatterns = [
      `${baseName}.test.%`,
      `${baseName}.spec.%`,
      `%test%${match.file.split('/').pop()?.replace(/\.[^.]+$/, '')}%`,
    ];

    for (const pattern of testPatterns) {
      const testFiles = db.prepare('SELECT path FROM files WHERE path LIKE ?').all(pattern) as Array<{ path: string }>;
      for (const tf of testFiles) {
        const key = `${tf.path}:__test__`;
        if (!resultMap.has(key)) {
          resultMap.set(key, {
            file: tf.path,
            symbol: null,
            kind: null,
            line: null,
            signature: null,
            reason: `Test file for ${match.file}`,
            relevance: 30,
            calls: [],
            calledBy: [],
            lastChanged: null,
          });
        }
      }
    }
  }

  // Sort by relevance and return
  return [...resultMap.values()]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, opts.limit);
}

function extractKeywords(task: string): string[] {
  // Only filter true natural language stop words.
  // Programming verbs (create, update, delete, etc.) are kept — they form identifier names.
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
    'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither',
    'this', 'that', 'these', 'those', 'it', 'its',
    'que', 'el', 'la', 'los', 'las', 'un', 'una', 'de', 'en', 'con',
    'por', 'para', 'como', 'del', 'al',
  ]);

  return task
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w))
    .slice(0, 10);
}

function computeRelevance(symbolName: string, keyword: string, isExported: boolean): number {
  const lower = symbolName.toLowerCase();
  const kw = keyword.toLowerCase();

  let score = 0;

  // Exact match
  if (lower === kw) score = 100;
  // Starts with
  else if (lower.startsWith(kw)) score = 85;
  // Contains
  else if (lower.includes(kw)) score = 70;
  // Partial/fuzzy
  else score = 50;

  // Bonus for exported symbols
  if (isExported) score += 5;

  return Math.min(score, 100);
}
