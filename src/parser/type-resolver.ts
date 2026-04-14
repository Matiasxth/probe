import type Database from 'better-sqlite3';

/**
 * Resolves method calls (obj.method()) to actual class methods using:
 *   1. Type hints from variable declarations: `const user: User = ...` → user.save() → User.save
 *   2. Type hints from function parameters: `function foo(user: User)` → user.save() → User.save
 *   3. Type hints from constructors: `const user = new User()` → user.save() → User.save
 *   4. Fallback: single method match or import-based disambiguation
 */
export function resolveMethodCalls(db: Database.Database): number {
  // 1. Build method index: methodName → [{symbolId, className, fileId}]
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

  // 2. Load type hints: fileId → scope → variableName → typeName
  const allHints = db.prepare('SELECT file_id, scope, variable_name, type_name FROM type_hints').all() as Array<{
    file_id: number; scope: string; variable_name: string; type_name: string;
  }>;

  const typeHintMap = new Map<number, Map<string, Map<string, string>>>(); // fileId → scope → varName → typeName
  for (const h of allHints) {
    const fileMap = typeHintMap.get(h.file_id) ?? new Map();
    const scopeMap = fileMap.get(h.scope) ?? new Map();
    scopeMap.set(h.variable_name, h.type_name);
    fileMap.set(h.scope, scopeMap);
    typeHintMap.set(h.file_id, fileMap);
  }

  // 3. Get call sites with receiver_name (method calls like obj.method())
  const unresolvedCallSites = db.prepare(`
    SELECT cs.file_id, cs.caller_name, cs.callee_name, cs.receiver_name, cs.line
    FROM call_sites cs
    WHERE cs.receiver_name IS NOT NULL
  `).all() as Array<{
    file_id: number; caller_name: string; callee_name: string; receiver_name: string; line: number;
  }>;

  // 4. Get caller symbol IDs
  const callerCache = new Map<string, number | null>();
  function getCallerId(fileId: number, callerName: string): number | null {
    const key = `${fileId}:${callerName}`;
    if (callerCache.has(key)) return callerCache.get(key)!;
    const parts = callerName.split('.');
    const name = parts[parts.length - 1];
    const row = db.prepare('SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1').get(fileId, name) as { id: number } | undefined;
    const id = row?.id ?? null;
    callerCache.set(key, id);
    return id;
  }

  const insertCall = db.prepare('INSERT INTO calls (caller_symbol_id, callee_symbol_id, line) VALUES (?, ?, ?)');
  const seen = new Set<string>();
  let resolved = 0;

  const tx = db.transaction(() => {
    for (const cs of unresolvedCallSites) {
      const callerId = getCallerId(cs.file_id, cs.caller_name);
      if (!callerId) continue;

      const candidates = methodIndex.get(cs.callee_name);
      if (!candidates || candidates.length === 0) continue;

      let targetId: number | undefined;

      // Strategy A: Use type hints to resolve receiver type
      const fileHints = typeHintMap.get(cs.file_id);
      if (fileHints) {
        // Check function scope first, then module scope
        const callerScope = cs.caller_name.split('.').pop() ?? cs.caller_name;
        const scopes = [callerScope, cs.caller_name, '__module__'];

        for (const scope of scopes) {
          const scopeHints = fileHints.get(scope);
          if (scopeHints) {
            const typeName = scopeHints.get(cs.receiver_name);
            if (typeName) {
              const match = candidates.find((c) => c.className === typeName);
              if (match) {
                targetId = match.id;
                break;
              }
            }
          }
        }
      }

      // Strategy B: Single candidate (only one class has this method)
      if (!targetId && candidates.length === 1) {
        targetId = candidates[0].id;
      }

      // Strategy C: Import-based disambiguation
      if (!targetId && candidates.length > 1) {
        const fileImports = db.prepare('SELECT imported_names FROM imports WHERE file_id = ?').all(cs.file_id) as Array<{ imported_names: string }>;
        const importedNames = new Set<string>();
        for (const imp of fileImports) {
          for (const name of JSON.parse(imp.imported_names)) importedNames.add(name);
        }
        const imported = candidates.find((c) => importedNames.has(c.className));
        if (imported) targetId = imported.id;
      }

      // Strategy D: Same file
      if (!targetId) {
        const sameFile = candidates.find((c) => c.fileId === cs.file_id);
        if (sameFile) targetId = sameFile.id;
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
