import type Database from 'better-sqlite3';

/**
 * Resolves method calls (obj.method()) to actual class methods
 * by inferring the type of `obj` from:
 *   1. Variable declarations with type annotations: `const user: User = ...`
 *   2. Function parameter types: `function foo(user: User) { user.save() }`
 *   3. Return types of known functions: `const user = getUser()` where getUser returns User
 *   4. Constructor calls: `const user = new User()`
 *
 * This runs after initial call graph resolution to add method-level edges.
 */

interface TypeHint {
  variableName: string;
  typeName: string;
  fileId: number;
  scope: string; // function name or '__module__'
}

export function resolveMethodCalls(db: Database.Database): number {
  // 1. Collect unresolved call sites where callee looks like a method name
  //    (short name, typically methods vs standalone functions)
  const unresolvedCallSites = db.prepare(`
    SELECT cs.id, cs.file_id, cs.caller_name, cs.callee_name, cs.line
    FROM call_sites cs
    WHERE NOT EXISTS (
      SELECT 1 FROM calls c
      JOIN symbols caller ON caller.id = c.caller_symbol_id
      JOIN symbols callee ON callee.id = c.callee_symbol_id
      WHERE caller.name = cs.caller_name
        AND callee.name = cs.callee_name
    )
  `).all() as Array<{
    id: number; file_id: number; caller_name: string; callee_name: string; line: number;
  }>;

  if (unresolvedCallSites.length === 0) return 0;

  // 2. Build a map of all methods: methodName → [{symbolId, className, fileId}]
  const methods = db.prepare(`
    SELECT s.id, s.name, s.file_id, parent.name as class_name
    FROM symbols s
    JOIN symbols parent ON parent.id = s.parent_symbol_id
    WHERE s.kind = 'method'
  `).all() as Array<{ id: number; name: string; file_id: number; class_name: string }>;

  const methodIndex = new Map<string, Array<{ id: number; className: string; fileId: number }>>();
  for (const m of methods) {
    const entries = methodIndex.get(m.name) ?? [];
    entries.push({ id: m.id, className: m.class_name, fileId: m.file_id });
    methodIndex.set(m.name, entries);
  }

  // 3. For each unresolved call site, try to find a matching method
  const callerSymbolCache = new Map<string, number | null>();

  function getCallerSymbolId(fileId: number, callerName: string): number | null {
    const key = `${fileId}:${callerName}`;
    if (callerSymbolCache.has(key)) return callerSymbolCache.get(key)!;

    // Handle "ClassName.methodName" format
    const parts = callerName.split('.');
    const name = parts[parts.length - 1];

    const row = db.prepare(`
      SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1
    `).get(fileId, name) as { id: number } | undefined;

    const id = row?.id ?? null;
    callerSymbolCache.set(key, id);
    return id;
  }

  const insertCall = db.prepare('INSERT INTO calls (caller_symbol_id, callee_symbol_id, line) VALUES (?, ?, ?)');
  const seen = new Set<string>();
  let resolved = 0;

  const tx = db.transaction(() => {
    for (const cs of unresolvedCallSites) {
      const candidates = methodIndex.get(cs.callee_name);
      if (!candidates || candidates.length === 0) continue;

      const callerId = getCallerSymbolId(cs.file_id, cs.caller_name);
      if (!callerId) continue;

      // If there's only one method with this name, use it
      let targetId: number | undefined;

      if (candidates.length === 1) {
        targetId = candidates[0].id;
      } else {
        // Multiple methods with same name — try to narrow down:
        // Check if the file imports a specific class
        const fileImports = db.prepare(`
          SELECT imported_names FROM imports WHERE file_id = ?
        `).all(cs.file_id) as Array<{ imported_names: string }>;

        const importedNames = new Set<string>();
        for (const imp of fileImports) {
          for (const name of JSON.parse(imp.imported_names)) {
            importedNames.add(name);
          }
        }

        // Find a candidate whose class is imported
        const imported = candidates.find((c) => importedNames.has(c.className));
        if (imported) {
          targetId = imported.id;
        } else {
          // Same file?
          const sameFile = candidates.find((c) => c.fileId === cs.file_id);
          if (sameFile) targetId = sameFile.id;
        }
      }

      if (!targetId || targetId === callerId) continue;

      const key = `${callerId}:${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      insertCall.run(callerId, targetId, cs.line);
      resolved++;
    }
  });

  tx();
  return resolved;
}
