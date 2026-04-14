# Feature Proposal: Pre-computed codebase index for agent context

## Problem

Claude Code spends ~50% of tool calls on exploration — reading files to understand what's relevant before it can start working. On a 284-file project, a typical task like "fix the login bug" generates this:

```
grep "login" → 15 results
Read file 1 → not relevant
Read file 2 → partially relevant
Read file 3 → this is the one
Read its imports → find dependency
Read test file → understand coverage
...
```

**10-15 tool calls** before writing a single line of code. This costs tokens, time, and often leads to missed context (the agent doesn't know what it'll break).

## Data

I built [probe](https://github.com/Matiasxth/probe), a proof-of-concept that pre-computes a function-level codebase index. Tested on two real projects:

| Metric | archmap (63 files) | appcelular (284 files) |
|--------|-------------------|----------------------|
| Symbols indexed | 260 | 2,148 |
| Call edges resolved | 191 | 870 |
| Full index time | 1.5s | 1.8s |
| Incremental (no changes) | 0.2s | — |

### Before (current agent behavior)

Task: "fix the login timeout"

```
Tool calls to find relevant code:
  1. Grep "login" → 15 results
  2. Read backend/app/api/auth.py → found handler
  3. Read backend/app/services/auth_service.py → found service
  4. Read backend/app/services/auth_service.py imports → found dependency
  5. Grep "session" → 8 results
  6. Read backend/app/core/security.py → found verify_password
  7. Read tests/ directory listing → found test files
  8. Read backend/tests/test_auth.py → found tests
  9. Read frontend/src/pages/auth/LoginPage.tsx → found frontend caller
  10. Grep "timeout" → find config

Total: ~10 tool calls, ~30s, significant context window usage
```

### After (with pre-computed index)

Same task, single query:

```
probe_query("fix login timeout")

→ Primary matches:
  backend/app/api/auth.py → login() [line 19]
    Called by: native/app/login.tsx:handleLogin, frontend/LoginPage.tsx:handleSubmit

  backend/app/services/auth_service.py → authenticate() [line 15]  ← found via synonym
    Called by: auth_service.py:login
    Calls: core/security.py:verify_password

→ Tests:
  backend/tests/test_auth.py (9 test cases)
  backend/tests/test_auth_security.py (5 test cases)

→ Patterns:
  Error handling: async def, raises exceptions
  Test style: integration (real DB)

Total: 1 tool call, <100ms, minimal context usage
```

**10 tool calls → 1. Same information. More complete.**

## What the index provides that grep/read cannot

1. **Call graph at function level**: `handleLogin → login → authenticate → verify_password`. Not inferable from imports alone — requires AST parsing of actual call sites.

2. **Impact analysis**: "If you change `authenticate()`, these 4 functions break, these 2 test files cover it, and `security.py` co-changes 80% of the time." No way to get this from sequential file reads.

3. **Semantic search**: Searching "login" also finds `authenticate()`, `signin()`, `session()` without an LLM — via static synonym mapping. Grep can't do this.

4. **Pattern detection**: Before writing code, the agent knows the project uses `snake_case`, `async def`, integration tests, and specific error handling patterns. Currently requires reading 5-6 files to absorb.

## How it works (no LLM, fully offline)

1. **Tree-sitter AST** parses every file → extracts functions, classes, methods, types with signatures
2. **Call site extraction** from AST → raw `caller_name, callee_name` pairs
3. **Import graph resolution** → maps call sites to actual symbol IDs across files
4. **Method call resolution** → resolves `obj.method()` via import-based type inference
5. **Git history analysis** → co-change correlation between files
6. **Pattern extraction** → naming conventions, error handling, test structure
7. **SQLite + FTS5** → instant queries with full-text search

Supports: TypeScript, JavaScript, Python, Go. Index updates incrementally (only re-parses changed files).

## Proposal

Build this into Claude Code's core, not as an external tool:

1. **Auto-index on first interaction** with a project (1-2s for most codebases)
2. **Auto-update** via file watcher (already implemented in probe's MCP server)
3. **Consult before every task** — the agent should never start reading files blindly when an index exists
4. **Impact check before every edit** — the agent should know what it'll break

The index is the "codebase memory" that persists between conversations. CLAUDE.md is prose; the index is structured, queryable, always up-to-date.

## Proof of concept

- **npm**: `npx probe-code index && npx probe-code query "your task"`
- **MCP server**: `npx probe-mcp .` (8 tools, auto-reindex)
- **GitHub**: [github.com/Matiasxth/probe](https://github.com/Matiasxth/probe)
- **Programmatic API**: `import { queryCodebase, analyzeImpact } from 'probe-code'`

~3,500 lines of TypeScript. 56 tests. MIT license.

---

*Built by [@matiasxth](https://github.com/Matiasxth) — full-stack developer and [archmap](https://github.com/Matiasxth/archmap) author.*
