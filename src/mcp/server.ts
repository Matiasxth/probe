import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDatabase, getMeta } from '../storage/database.js';
import { queryCodebase } from '../engine/query.js';
import { analyzeImpact } from '../engine/impact.js';
import {
  getPatterns,
  getStats,
  getSymbolsByFile,
  findSymbolByName,
  getCallers,
  getCallees,
  getCoChanges,
  getAllFiles,
  getImportsByFile,
  getFileByPath,
} from '../storage/queries.js';
import type Database from 'better-sqlite3';

export async function startMcpServer(root: string): Promise<void> {
  const db = openDatabase(root);

  const server = new McpServer({
    name: 'probe',
    version: getMeta(db, 'version') ?? '0.1.0',
  });

  // === probe_query ===
  server.tool(
    'probe_query',
    'Find relevant files and symbols for a task. Returns ranked results with call graph context.',
    { task: z.string().describe('Natural language task description, e.g. "fix login timeout"'), limit: z.number().optional().default(10) },
    async ({ task, limit }) => {
      const results = queryCodebase(db, task, { limit });
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    },
  );

  // === probe_impact ===
  server.tool(
    'probe_impact',
    'Analyze what breaks if you change a symbol. Returns direct/indirect dependents, co-changes, and tests.',
    { target: z.string().describe('Target: "file.ts:line", "file.ts:functionName", or "functionName"'), depth: z.number().optional().default(3) },
    async ({ target, depth }) => {
      const result = analyzeImpact(db, target, depth);
      if (!result) return { content: [{ type: 'text', text: 'Symbol not found' }] };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // === probe_patterns ===
  server.tool(
    'probe_patterns',
    'Get codebase conventions: naming, error handling, test patterns, import style. Use before writing new code.',
    { category: z.string().optional().describe('Filter: naming, error_handling, structure, tests, imports') },
    async ({ category }) => {
      const patterns = getPatterns(db, category);
      return { content: [{ type: 'text', text: JSON.stringify(patterns, null, 2) }] };
    },
  );

  // === probe_function ===
  server.tool(
    'probe_function',
    'Get details about a specific function: signature, callers, callees, location.',
    { name: z.string().describe('Function name to look up') },
    async ({ name }) => {
      const symbols = findSymbolByName(db, name);
      if (symbols.length === 0) return { content: [{ type: 'text', text: `No symbol named "${name}" found` }] };

      const details = symbols.map((sym) => {
        const callers = getCallers(db, sym.id).map((c) => `${c.file_path}:${c.name}`);
        const callees = getCallees(db, sym.id).map((c) => `${c.file_path}:${c.name}`);
        return {
          name: sym.name,
          kind: sym.kind,
          file: sym.file_path,
          line: sym.line_start,
          signature: sym.signature,
          docComment: sym.doc_comment,
          exported: sym.is_exported === 1,
          callers,
          callees,
        };
      });

      return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
    },
  );

  // === probe_file ===
  server.tool(
    'probe_file',
    'Get file summary: all symbols, exports, imports, and their relationships.',
    { path: z.string().describe('File path relative to project root') },
    async ({ path: filePath }) => {
      const file = getFileByPath(db, filePath);
      if (!file) return { content: [{ type: 'text', text: `File not found: ${filePath}` }] };

      const symbols = getSymbolsByFile(db, filePath);
      const imports = getImportsByFile(db, file.id);
      const coChanges = getCoChanges(db, filePath);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            path: filePath,
            language: file.language,
            size: file.size,
            symbols: symbols.map((s) => ({
              name: s.name,
              kind: s.kind,
              line: s.line_start,
              signature: s.signature,
              exported: s.is_exported === 1,
            })),
            imports: imports.map((i) => ({
              source: i.source_path,
              names: JSON.parse(i.imported_names),
            })),
            coChanges: coChanges.slice(0, 5),
          }, null, 2),
        }],
      };
    },
  );

  // === probe_depends ===
  server.tool(
    'probe_depends',
    'Get the full dependency chain for a function — everything it depends on.',
    { name: z.string().describe('Function name'), depth: z.number().optional().default(3) },
    async ({ name, depth }) => {
      const symbols = findSymbolByName(db, name);
      const sym = symbols.find((s) => s.is_exported) ?? symbols[0];
      if (!sym) return { content: [{ type: 'text', text: `No symbol named "${name}" found` }] };

      const deps: Array<{ name: string; file: string; depth: number }> = [];
      const visited = new Set<number>([sym.id]);
      const queue: Array<{ id: number; d: number }> = [{ id: sym.id, d: 0 }];

      while (queue.length > 0) {
        const { id, d } = queue.shift()!;
        if (d >= depth) continue;

        const callees = getCallees(db, id);
        for (const callee of callees) {
          if (visited.has(callee.id)) continue;
          visited.add(callee.id);
          deps.push({ name: callee.name, file: callee.file_path ?? '', depth: d + 1 });
          queue.push({ id: callee.id, d: d + 1 });
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ root: name, dependencies: deps }, null, 2) }] };
    },
  );

  // === probe_history ===
  server.tool(
    'probe_history',
    'Get co-change history for a file — which files typically change together.',
    { path: z.string().describe('File path relative to project root') },
    async ({ path: filePath }) => {
      const coChanges = getCoChanges(db, filePath);
      return { content: [{ type: 'text', text: JSON.stringify(coChanges, null, 2) }] };
    },
  );

  // === probe_suggest ===
  server.tool(
    'probe_suggest',
    'Suggest which files to read/modify for a task. Returns prioritized file list with reasons.',
    { task: z.string().describe('What you want to accomplish') },
    async ({ task }) => {
      const results = queryCodebase(db, task, { limit: 10 });

      // Format as a prioritized action list
      const suggestions = results.map((r, i) => ({
        priority: i + 1,
        action: r.relevance >= 60 ? 'READ' : r.relevance >= 30 ? 'CHECK' : 'AWARE',
        file: r.file,
        symbol: r.symbol,
        line: r.line,
        reason: r.reason,
      }));

      // Add patterns as context
      const patterns = getPatterns(db);
      const relevantPatterns = patterns
        .filter((p) => p.confidence > 0.7)
        .slice(0, 5)
        .map((p) => `${p.name}: ${p.value}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ files: suggestions, conventions: relevantPatterns }, null, 2),
        }],
      };
    },
  );

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
