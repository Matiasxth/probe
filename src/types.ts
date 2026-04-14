// ===== Config =====

export interface ProbeConfig {
  version: number;
  exclude: string[];
  languages: string[];
  gitHistory: {
    maxCommits: number;
    minCoChangeConfidence: number;
  };
}

export const DEFAULT_CONFIG: ProbeConfig = {
  version: 1,
  exclude: ['node_modules', 'dist', 'build', '.git', 'vendor', '__pycache__', '.probe', 'coverage', '.next', '.nuxt'],
  languages: ['typescript', 'javascript', 'python', 'go', 'rust', 'java'],
  gitHistory: {
    maxCommits: 500,
    minCoChangeConfidence: 0.5,
  },
};

// ===== Language mapping =====

export const LANG_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
};

export const EXT_TO_LANG: Record<string, string> = Object.fromEntries(
  Object.entries(LANG_EXTENSIONS).flatMap(([lang, exts]) => exts.map((ext) => [ext, lang])),
);

// ===== Database models =====

export interface FileRecord {
  id: number;
  path: string;
  language: string;
  size: number;
  hash: string;
}

export type SymbolKind = 'function' | 'class' | 'method' | 'type' | 'interface' | 'variable' | 'enum' | 'constant';

export interface SymbolRecord {
  id: number;
  fileId: number;
  name: string;
  kind: SymbolKind;
  lineStart: number;
  lineEnd: number;
  signature: string;
  docComment: string | null;
  isExported: boolean;
  isDefault: boolean;
  parentSymbolId: number | null;
}

export interface ImportRecord {
  id: number;
  fileId: number;
  sourcePath: string;
  importedNames: string;   // JSON array
  isDefault: boolean;
  isNamespace: boolean;
}

export interface CallRecord {
  id: number;
  callerSymbolId: number;
  calleeSymbolId: number;
  line: number;
}

export interface TypeRefRecord {
  id: number;
  symbolId: number;
  referencedSymbolId: number;
}

export interface CoChangeRecord {
  filePathA: string;
  filePathB: string;
  changeCount: number;
  totalCommits: number;
  confidence: number;
}

export interface PatternRecord {
  category: string;
  name: string;
  value: string;
  instanceCount: number;
  totalCount: number;
  confidence: number;
  examples: string;  // JSON array
}

// ===== Parser output (before DB insert) =====

export interface ParsedFile {
  path: string;
  language: string;
  size: number;
  hash: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  callSites: ParsedCallSite[];
  typeHints?: ParsedTypeHint[];
}

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  lineStart: number;
  lineEnd: number;
  signature: string;
  docComment: string | null;
  isExported: boolean;
  isDefault: boolean;
  parentName: string | null;
  tags?: string[];
}

export interface ParsedImport {
  sourcePath: string;
  importedNames: string[];          // local names (what the code uses)
  originalNames?: Record<string, string>;  // alias → original name mapping (only if different)
  isDefault: boolean;
  isNamespace: boolean;
}

export interface ParsedTypeHint {
  scope: string;         // function name or '__module__'
  variableName: string;  // e.g., "user"
  typeName: string;      // e.g., "User"
  source: 'annotation' | 'constructor' | 'parameter' | 'return';
}

export interface ParsedCallSite {
  callerName: string;
  calleeName: string;
  receiverName?: string;  // e.g., "user" from user.save()
  line: number;
}

// ===== Query results =====

export interface QueryMatch {
  file: string;
  symbol: string | null;
  kind: SymbolKind | null;
  line: number | null;
  signature: string | null;
  reason: string;
  relevance: number;     // 0-100
  calls: string[];
  calledBy: string[];
  lastChanged: string | null;
}

export interface ImpactResult {
  target: {
    file: string;
    symbol: string;
    kind: SymbolKind;
    line: number;
    signature: string;
  };
  directDependents: Array<{
    file: string;
    symbol: string;
    line: number;
    type: 'call' | 'type' | 'import';
  }>;
  indirectDependents: Array<{
    file: string;
    symbol: string;
    line: number;
    depth: number;
  }>;
  coChangeCorrelations: Array<{
    file: string;
    confidence: number;
    changeCount: number;
  }>;
  tests: Array<{
    file: string;
    testName: string | null;
    line: number;
  }>;
}

export interface PatternSummary {
  naming: PatternEntry[];
  errorHandling: PatternEntry[];
  structure: PatternEntry[];
  tests: PatternEntry[];
  imports: PatternEntry[];
}

export interface PatternEntry {
  name: string;
  value: string;
  ratio: string;
  confidence: number;
  outliers: string[];
}

// ===== Scan result =====

export interface ScanResult {
  files: number;
  symbols: number;
  calls: number;
  coChanges: number;
  patterns: number;
  duration: number;
  languages: Record<string, number>;
}
