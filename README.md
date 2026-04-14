# probe

> Codebase intelligence for AI agents

[![npm version](https://img.shields.io/npm/v/probe-code.svg)](https://www.npmjs.com/package/probe-code)
[![license](https://img.shields.io/npm/l/probe-code.svg)](https://github.com/matiasxth/probe/blob/main/LICENSE)

AI agents waste time reading files blindly. **probe** indexes your codebase at function-level and answers questions before the agent starts coding.

```bash
npx probe-code index
```

One command. Your agent now knows every function, call chain, and coding pattern.

| Surface | What it provides |
|---------|-----------------|
| **CLI** | Query, impact analysis, pattern extraction |
| **MCP** | 8 tools any agent can call in real-time |
| **JSON** | Structured output for pipelines |
| **API** | Programmatic access from your code |

## The problem

An AI agent working on your code does this:

```
grep "login" → 15 results
read file 1 → not relevant
read file 2 → not relevant
read file 3 → finally relevant
read its imports → find another file
... 10 tool calls later
```

With probe:

```
probe_query("fix login timeout") → 4 relevant files, ranked, with context
```

Three calls replace fifteen.

## Quick start

```bash
# Index your project
npx probe-code index

# Find relevant code for a task
npx probe-code query "fix the login timeout"

# See what breaks if you change something
npx probe-code impact "src/auth/service.ts:45"

# Get codebase conventions
npx probe-code patterns

# Start MCP server for agents
npx probe-code serve
```

## What it indexes

probe extracts from every file:

- **Functions, classes, methods, types** — name, signature, line numbers
- **Call graph** — who calls what, resolved through imports
- **Import graph** — all module dependencies
- **Co-change patterns** — from git history, which files change together
- **Coding patterns** — naming conventions, error handling, test structure

Stored in `.probe/probe.db` (SQLite). Fully offline, no API keys.

## Commands

### `probe index`

Scans the codebase, builds the function-level index.

```bash
probe index                    # current directory
probe index --root ./my-project
probe index --no-git           # skip git history analysis
probe index --verbose          # show per-file progress
```

### `probe query <task>`

Find relevant files and symbols for a natural language task.

```bash
probe query "fix the login timeout"
probe query "add payment endpoint" --limit 20
probe query "refactor database layer" --json
```

Output groups results by relevance:
- **Primary matches** — direct symbol/file name matches
- **Related** — connected via call graph
- **Co-change** — files that historically change together

### `probe impact <target>`

Show what breaks if you change a function.

```bash
probe impact "src/auth/service.ts:45"       # by file:line
probe impact "src/auth/service.ts:loginUser" # by file:name
probe impact "loginUser"                     # by name (finds best match)
probe impact "loginUser" --depth 5           # deeper traversal
```

Output:
- **Direct dependents** — functions that call this (break if signature changes)
- **Type dependents** — functions using return types
- **Indirect dependents** — transitive callers (configurable depth)
- **Co-change history** — files that always change together
- **Tests** — test files covering this function

### `probe patterns`

Show coding conventions extracted from the actual codebase.

```bash
probe patterns
probe patterns --json
```

Detects:
- Naming conventions (camelCase, snake_case, PascalCase) per symbol kind
- File naming patterns
- Error handling style (Result<T,E>, try/catch, throws)
- Test location, naming, and coverage ratio
- Import style (relative vs absolute)
- Export ratio

### `probe stats`

Show index statistics.

### `probe serve`

Start MCP server for AI agent integration.

## MCP Server

8 tools for real-time codebase queries:

```json
{
  "mcpServers": {
    "probe": {
      "command": "npx",
      "args": ["probe-mcp", "."]
    }
  }
}
```

| Tool | Description |
|------|-------------|
| `probe_query` | Find relevant files for a task |
| `probe_impact` | What breaks if you change X |
| `probe_patterns` | Codebase conventions |
| `probe_function` | Details about a specific function |
| `probe_file` | File summary with all symbols |
| `probe_depends` | Full dependency chain for a function |
| `probe_history` | Co-change history for a file |
| `probe_suggest` | Prioritized file list for a task |

## Programmatic API

```typescript
import { openDatabase, queryCodebase, analyzeImpact, getPatterns } from 'probe-code';

const db = openDatabase('./my-project');

// Query
const results = queryCodebase(db, 'fix login bug', { limit: 10 });

// Impact
const impact = analyzeImpact(db, 'loginUser', 3);

// Patterns
const patterns = getPatterns(db);
```

## Supported languages

TypeScript, JavaScript, Python, Go — all with tree-sitter AST parsing.

## How it works (no LLM required)

1. **Index** — tree-sitter parses every file, extracts symbols and call sites
2. **Resolve** — imports are matched to build a cross-file call graph
3. **Analyze** — git history reveals co-change patterns
4. **Extract** — naming, error handling, and structural patterns are detected
5. **Query** — keyword matching + graph traversal + co-change ranking

Everything runs locally. No API calls. No cloud. No cost.

## License

MIT
