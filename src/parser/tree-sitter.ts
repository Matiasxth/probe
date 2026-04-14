import Parser from 'web-tree-sitter';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let initialized = false;
const parserCache = new Map<string, Parser>();

const WASM_MAP: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
};

async function init(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

function resolveWasm(name: string): string {
  const wasmDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  return path.join(wasmDir, 'out', name);
}

export async function getParser(language: string, isTsx = false): Promise<Parser | null> {
  const key = language === 'typescript' && isTsx ? 'tsx' : language;
  const cached = parserCache.get(key);
  if (cached) return cached;

  const wasmFile = WASM_MAP[key];
  if (!wasmFile) return null;

  await init();

  try {
    const parser = new Parser();
    const lang = await Parser.Language.load(resolveWasm(wasmFile));
    parser.setLanguage(lang);
    parserCache.set(key, parser);
    return parser;
  } catch {
    return null;
  }
}

export function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse(source);
}
