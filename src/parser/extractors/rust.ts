import type Parser from 'web-tree-sitter';
import type { ParsedSymbol, ParsedImport, ParsedCallSite, SymbolKind } from '../../types.js';

export function extractRust(tree: Parser.Tree, source: string): {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  callSites: ParsedCallSite[];
} {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const callSites: ParsedCallSite[] = [];
  const lines = source.split('\n');

  let currentFunction: string | null = null;
  let currentImpl: string | null = null; // type name from impl block

  function getDocComment(node: Parser.SyntaxNode): string | null {
    const prev = node.previousNamedSibling;
    if (prev?.type === 'line_comment' || prev?.type === 'block_comment') {
      const text = prev.text;
      if (text.startsWith('///') || text.startsWith('//!') || text.startsWith('/**')) return text;
    }
    return null;
  }

  function isPublic(node: Parser.SyntaxNode): boolean {
    for (const child of node.children) {
      if (child.type === 'visibility_modifier') return true;
    }
    return false;
  }

  function extractSig(node: Parser.SyntaxNode): string {
    const startLine = node.startPosition.row;
    const line = lines[startLine]?.trim() ?? '';
    const braceIdx = line.indexOf('{');
    const sig = braceIdx > 0 ? line.slice(0, braceIdx).trim() : line;
    return sig.length > 200 ? sig.slice(0, 200) + '...' : sig;
  }

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      // === Functions ===
      case 'function_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const kind: SymbolKind = currentImpl ? 'method' : 'function';
          symbols.push({
            name,
            kind,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isPublic(node),
            isDefault: false,
            parentName: currentImpl,
          });
          const prevFunc = currentFunction;
          currentFunction = currentImpl ? `${currentImpl}.${name}` : name;
          walkChildren(node);
          currentFunction = prevFunc;
          return;
        }
        break;
      }

      // === Impl blocks ===
      case 'impl_item': {
        const typeNode = node.childForFieldName('type');
        if (typeNode) {
          const prevImpl = currentImpl;
          currentImpl = typeNode.text.replace(/[<>]/g, '').split('<')[0]; // Strip generics
          walkChildren(node);
          currentImpl = prevImpl;
          return;
        }
        break;
      }

      // === Structs ===
      case 'struct_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'class',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isPublic(node),
            isDefault: false,
            parentName: null,
          });
        }
        break;
      }

      // === Enums ===
      case 'enum_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'enum',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isPublic(node),
            isDefault: false,
            parentName: null,
          });
        }
        break;
      }

      // === Traits ===
      case 'trait_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'interface',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isPublic(node),
            isDefault: false,
            parentName: null,
          });
          const prevImpl = currentImpl;
          currentImpl = nameNode.text;
          walkChildren(node);
          currentImpl = prevImpl;
          return;
        }
        break;
      }

      // === Type aliases ===
      case 'type_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'type',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isPublic(node),
            isDefault: false,
            parentName: null,
          });
        }
        break;
      }

      // === Constants / Statics ===
      case 'const_item':
      case 'static_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'constant',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isPublic(node),
            isDefault: false,
            parentName: currentImpl,
          });
        }
        break;
      }

      // === Use declarations (imports) ===
      case 'use_declaration': {
        const arg = node.namedChildren.find((c) => c.type === 'use_as_clause' || c.type === 'scoped_identifier' || c.type === 'use_list' || c.type === 'identifier' || c.type === 'scoped_use_list');
        if (arg) {
          parseUseDecl(arg);
        }
        break;
      }

      // === Call expressions ===
      case 'call_expression': {
        if (currentFunction) {
          const funcNode = node.childForFieldName('function');
          if (funcNode) {
            let calleeName: string;
            if (funcNode.type === 'field_expression') {
              const field = funcNode.childForFieldName('field');
              calleeName = field?.text ?? funcNode.text;
            } else if (funcNode.type === 'scoped_identifier') {
              // Type::method()
              const name = funcNode.childForFieldName('name');
              calleeName = name?.text ?? funcNode.text.split('::').pop() ?? funcNode.text;
            } else {
              calleeName = funcNode.text;
            }
            if (calleeName.length < 100) {
              callSites.push({
                callerName: currentFunction,
                calleeName,
                line: node.startPosition.row + 1,
              });
            }
          }
        }
        break;
      }

      // === Macro invocations ===
      case 'macro_invocation': {
        if (currentFunction) {
          const macroNode = node.childForFieldName('macro');
          if (macroNode) {
            const name = macroNode.text.replace('!', '');
            if (name.length < 50 && !['println', 'print', 'eprintln', 'eprint', 'format', 'vec', 'dbg', 'todo', 'unimplemented', 'unreachable', 'assert', 'assert_eq', 'assert_ne', 'debug_assert', 'cfg', 'include', 'env'].includes(name)) {
              callSites.push({
                callerName: currentFunction,
                calleeName: name,
                line: node.startPosition.row + 1,
              });
            }
          }
        }
        break;
      }
    }

    walkChildren(node);
  }

  function parseUseDecl(node: Parser.SyntaxNode): void {
    if (node.type === 'use_as_clause') {
      const path = node.childForFieldName('path');
      const alias = node.childForFieldName('alias');
      if (path) {
        const fullPath = path.text;
        const parts = fullPath.split('::');
        const sourcePath = parts.slice(0, -1).join('::');
        const originalName = parts[parts.length - 1];
        const localName = alias?.text ?? originalName;
        const origNames: Record<string, string> = {};
        if (alias && localName !== originalName) origNames[localName] = originalName;
        imports.push({
          sourcePath: resolveRustPath(sourcePath || fullPath),
          importedNames: [localName],
          ...(Object.keys(origNames).length > 0 ? { originalNames: origNames } : {}),
          isDefault: false,
          isNamespace: false,
        });
      }
    } else if (node.type === 'scoped_identifier') {
      const path = node.childForFieldName('path');
      const name = node.childForFieldName('name');
      if (name) {
        imports.push({
          sourcePath: resolveRustPath(path?.text ?? ''),
          importedNames: [name.text],
          isDefault: false,
          isNamespace: name.text === '*',
        });
      }
    } else if (node.type === 'use_list' || node.type === 'scoped_use_list') {
      for (const child of node.namedChildren) {
        parseUseDecl(child);
      }
    } else if (node.type === 'identifier') {
      imports.push({
        sourcePath: node.text,
        importedNames: [node.text],
        isDefault: false,
        isNamespace: false,
      });
    }
  }

  function resolveRustPath(rustPath: string): string {
    // crate::foo::bar → foo/bar
    // self::foo → ./foo
    // super::foo → ../foo
    return rustPath
      .replace(/^crate::/, '')
      .replace(/^self::/, './')
      .replace(/^super::/, '../')
      .replace(/::/g, '/');
  }

  function walkChildren(node: Parser.SyntaxNode): void {
    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return { symbols, imports, callSites };
}
