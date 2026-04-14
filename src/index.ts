export type {
  ProbeConfig,
  ParsedFile,
  ParsedSymbol,
  ParsedImport,
  ParsedCallSite,
  QueryMatch,
  ImpactResult,
  PatternSummary,
  ScanResult,
  SymbolKind,
} from './types.js';

export { DEFAULT_CONFIG } from './types.js';
export { openDatabase, clearDatabase, getMeta, setMeta } from './storage/database.js';
export { queryCodebase } from './engine/query.js';
export { analyzeImpact } from './engine/impact.js';
export { parseProject, resolveCallGraph } from './parser/index.js';
export { analyzeGitHistory } from './analysis/git-history.js';
export { extractPatterns } from './analysis/patterns.js';
export { getStats, getPatterns, searchSymbols } from './storage/queries.js';
