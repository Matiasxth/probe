import type Parser from 'web-tree-sitter';
import type { ParsedSymbol, ParsedImport, ParsedCallSite, SymbolKind } from '../../types.js';

export function extractPhp(tree: Parser.Tree, source: string): {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  callSites: ParsedCallSite[];
} {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const callSites: ParsedCallSite[] = [];
  const lines = source.split('\n');

  let currentFunction: string | null = null;
  let currentClass: string | null = null;
  let currentNamespace: string | null = null;

  function extractSig(node: Parser.SyntaxNode): string {
    const startLine = node.startPosition.row;
    const line = lines[startLine]?.trim() ?? '';
    const braceIdx = line.indexOf('{');
    const sig = braceIdx > 0 ? line.slice(0, braceIdx).trim() : line;
    return sig.length > 200 ? sig.slice(0, 200) + '...' : sig;
  }

  function getDocComment(node: Parser.SyntaxNode): string | null {
    const prev = node.previousNamedSibling;
    if (prev?.type === 'comment') {
      const text = prev.text;
      if (text.startsWith('/**')) return text;
    }
    return null;
  }

  function getVisibility(node: Parser.SyntaxNode): 'public' | 'protected' | 'private' {
    for (const child of node.children) {
      if (child.type === 'visibility_modifier') {
        if (child.text === 'private') return 'private';
        if (child.text === 'protected') return 'protected';
        if (child.text === 'public') return 'public';
      }
    }
    return 'public';
  }

  function isExported(node: Parser.SyntaxNode): boolean {
    const vis = getVisibility(node);
    return vis === 'public' || vis === 'protected';
  }

  function getReturnType(node: Parser.SyntaxNode): string | undefined {
    const returnType = node.childForFieldName('return_type');
    if (returnType) {
      let t = returnType.text.replace(/^\s*:\s*/, '').trim();
      // Strip nullable prefix
      t = t.replace(/^\?/, '');
      if (t.length < 50 && /^[A-Z]/.test(t)) return t;
    }
    return undefined;
  }

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      // === Namespace ===
      case 'namespace_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          currentNamespace = nameNode.text;
        }
        walkChildren(node);
        return;
      }

      // === Functions (top-level) ===
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const params = node.childForFieldName('parameters');
          let sig = `function ${name}(${params?.text ?? ''})`;
          const returnType = getReturnType(node);
          if (returnType) sig += `: ${returnType}`;

          symbols.push({
            name,
            kind: 'function',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: sig.length > 200 ? sig.slice(0, 200) + '...' : sig,
            docComment: getDocComment(node),
            isExported: true,
            isDefault: false,
            parentName: null,
            returnType,
          });

          const prevFunc = currentFunction;
          currentFunction = name;
          walkChildren(node);
          currentFunction = prevFunc;
          return;
        }
        break;
      }

      // === Methods ===
      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const params = node.childForFieldName('parameters');
          const vis = getVisibility(node);
          const isStatic = node.children.some((c) => c.type === 'static_modifier');
          const isAbstract = node.children.some((c) => c.text === 'abstract');

          let sig = '';
          if (vis !== 'public') sig += `${vis} `;
          if (isStatic) sig += 'static ';
          if (isAbstract) sig += 'abstract ';
          sig += `function ${name}(${params?.text ?? ''})`;
          const returnType = getReturnType(node);
          if (returnType) sig += `: ${returnType}`;

          symbols.push({
            name,
            kind: 'method',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: sig.length > 200 ? sig.slice(0, 200) + '...' : sig,
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: false,
            parentName: currentClass,
            returnType,
          });

          const prevFunc = currentFunction;
          currentFunction = currentClass ? `${currentClass}.${name}` : name;
          walkChildren(node);
          currentFunction = prevFunc;
          return;
        }
        break;
      }

      // === Classes ===
      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const baseClause = node.childForFieldName('base_clause');
          const interfaces = node.childForFieldName('interfaces');
          let sig = `class ${name}`;
          if (baseClause) sig += ` ${baseClause.text}`;
          if (interfaces) sig += ` ${interfaces.text}`;

          symbols.push({
            name,
            kind: 'class',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: sig.length > 200 ? sig.slice(0, 200) + '...' : sig,
            docComment: getDocComment(node),
            isExported: true,
            isDefault: false,
            parentName: null,
          });

          const prevClass = currentClass;
          currentClass = name;
          walkChildren(node);
          currentClass = prevClass;
          return;
        }
        break;
      }

      // === Interfaces ===
      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          symbols.push({
            name,
            kind: 'interface',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: true,
            isDefault: false,
            parentName: null,
          });

          const prevClass = currentClass;
          currentClass = name;
          walkChildren(node);
          currentClass = prevClass;
          return;
        }
        break;
      }

      // === Traits ===
      case 'trait_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          symbols.push({
            name,
            kind: 'class',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: `trait ${name}`,
            docComment: getDocComment(node),
            isExported: true,
            isDefault: false,
            parentName: null,
          });

          const prevClass = currentClass;
          currentClass = name;
          walkChildren(node);
          currentClass = prevClass;
          return;
        }
        break;
      }

      // === Enums ===
      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'enum',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: true,
            isDefault: false,
            parentName: null,
          });
        }
        break;
      }

      // === Class constants ===
      case 'const_declaration': {
        if (currentClass) {
          for (const child of node.namedChildren) {
            if (child.type === 'const_element') {
              const nameNode = child.childForFieldName('name');
              if (nameNode) {
                symbols.push({
                  name: nameNode.text,
                  kind: 'constant',
                  lineStart: node.startPosition.row + 1,
                  lineEnd: node.endPosition.row + 1,
                  signature: lines[node.startPosition.row]?.trim() ?? '',
                  docComment: null,
                  isExported: isExported(node),
                  isDefault: false,
                  parentName: currentClass,
                });
              }
            }
          }
        }
        break;
      }

      // === Properties ===
      case 'property_declaration': {
        if (currentClass) {
          for (const child of node.namedChildren) {
            if (child.type === 'property_element') {
              const varNode = child.namedChildren.find((c) => c.type === 'variable_name');
              if (varNode) {
                const name = varNode.text.replace(/^\$/, '');
                symbols.push({
                  name,
                  kind: 'variable',
                  lineStart: node.startPosition.row + 1,
                  lineEnd: node.endPosition.row + 1,
                  signature: lines[node.startPosition.row]?.trim() ?? '',
                  docComment: null,
                  isExported: isExported(node),
                  isDefault: false,
                  parentName: currentClass,
                });
              }
            }
          }
        }
        break;
      }

      // === Imports (use statements) ===
      case 'namespace_use_declaration': {
        for (const child of node.namedChildren) {
          if (child.type === 'namespace_use_clause') {
            const fullPath = child.text.replace(/^\\/, '');
            const parts = fullPath.split('\\');
            const localName = parts[parts.length - 1];
            const sourcePath = parts.slice(0, -1).join('\\');

            imports.push({
              sourcePath: sourcePath || fullPath,
              importedNames: [localName],
              isDefault: false,
              isNamespace: false,
            });
          } else if (child.type === 'namespace_aliasing_clause') {
            const nameNode = child.childForFieldName('name');
            const alias = child.childForFieldName('alias');
            if (nameNode) {
              const fullPath = nameNode.text.replace(/^\\/, '');
              const parts = fullPath.split('\\');
              const originalName = parts[parts.length - 1];
              const sourcePath = parts.slice(0, -1).join('\\');
              const localName = alias?.text ?? originalName;

              const imp: ParsedImport = {
                sourcePath: sourcePath || fullPath,
                importedNames: [localName],
                isDefault: false,
                isNamespace: false,
              };
              if (alias && localName !== originalName) {
                imp.originalNames = { [localName]: originalName };
              }
              imports.push(imp);
            }
          }
        }
        break;
      }

      // === Function calls ===
      case 'function_call_expression': {
        if (currentFunction) {
          const funcNode = node.childForFieldName('function');
          if (funcNode) {
            const calleeName = funcNode.type === 'name'
              ? funcNode.text
              : funcNode.text.split('\\').pop() ?? funcNode.text;
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

      // === Method calls: $obj->method() ===
      case 'member_call_expression': {
        if (currentFunction) {
          const nameNode = node.childForFieldName('name');
          const objectNode = node.childForFieldName('object');
          if (nameNode) {
            const calleeName = nameNode.text;
            const receiverName = objectNode?.type === 'variable_name'
              ? objectNode.text.replace(/^\$/, '')
              : undefined;
            if (calleeName.length < 100) {
              callSites.push({
                callerName: currentFunction,
                calleeName,
                ...(receiverName && receiverName !== 'this' ? { receiverName } : {}),
                line: node.startPosition.row + 1,
              });
            }
          }
        }
        break;
      }

      // === Static calls: Foo::bar() ===
      case 'scoped_call_expression': {
        if (currentFunction) {
          const nameNode = node.childForFieldName('name');
          const scopeNode = node.childForFieldName('scope');
          if (nameNode) {
            const calleeName = nameNode.text;
            const receiverName = scopeNode?.text;
            if (calleeName.length < 100) {
              callSites.push({
                callerName: currentFunction,
                calleeName,
                ...(receiverName && receiverName !== 'self' && receiverName !== 'static'
                  ? { receiverName }
                  : {}),
                line: node.startPosition.row + 1,
              });
            }
          }
        }
        break;
      }

      // === Object creation: new Foo() ===
      case 'object_creation_expression': {
        if (currentFunction) {
          const classNode = node.namedChildren.find(
            (c) => c.type === 'name' || c.type === 'qualified_name',
          );
          if (classNode) {
            const name = classNode.text.split('\\').pop() ?? classNode.text;
            if (name.length < 100) {
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

  function walkChildren(node: Parser.SyntaxNode): void {
    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return { symbols, imports, callSites };
}
