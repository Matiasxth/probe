import type Parser from 'web-tree-sitter';
import type { ParsedSymbol, ParsedImport, ParsedCallSite, SymbolKind } from '../../types.js';

export function extractTypeScript(tree: Parser.Tree, source: string): {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  callSites: ParsedCallSite[];
} {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const callSites: ParsedCallSite[] = [];
  const lines = source.split('\n');

  function getDocComment(node: Parser.SyntaxNode): string | null {
    const prev = node.previousNamedSibling;
    if (prev?.type === 'comment') {
      const text = prev.text;
      if (text.startsWith('/**') || text.startsWith('//')) return text;
    }
    return null;
  }

  function isExported(node: Parser.SyntaxNode): boolean {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === 'export_statement') return true;
    // Check for `export` modifier
    const firstChild = node.firstChild;
    if (firstChild?.type === 'export') return true;
    // Lexical declarations inside export
    if (parent.type === 'lexical_declaration' && parent.parent?.type === 'export_statement') return true;
    return false;
  }

  function isDefaultExport(node: Parser.SyntaxNode): boolean {
    const parent = node.parent;
    if (parent?.type === 'export_statement') {
      return parent.children.some((c) => c.type === 'default');
    }
    return false;
  }

  function extractSignature(node: Parser.SyntaxNode, name: string, kind: SymbolKind): string {
    if (kind === 'class' || kind === 'interface' || kind === 'enum') return `${kind} ${name}`;

    // Try to get the first line as signature
    const startLine = node.startPosition.row;
    const line = lines[startLine]?.trim() ?? '';
    // Truncate at opening brace
    const braceIdx = line.indexOf('{');
    const sig = braceIdx > 0 ? line.slice(0, braceIdx).trim() : line;
    return sig.length > 200 ? sig.slice(0, 200) + '...' : sig;
  }

  // Track current function scope for call sites
  let currentFunction: string | null = null;
  let currentClass: string | null = null;

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      // === Functions ===
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          symbols.push({
            name,
            kind: 'function',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSignature(node, name, 'function'),
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: isDefaultExport(node),
            parentName: currentClass,
          });
          const prevFunc = currentFunction;
          currentFunction = name;
          walkChildren(node);
          currentFunction = prevFunc;
          return;
        }
        break;
      }

      // Arrow functions: const foo = () => {}
      case 'lexical_declaration':
      case 'variable_declaration': {
        const declarator = node.namedChildren.find((c) => c.type === 'variable_declarator');
        if (declarator) {
          const nameNode = declarator.childForFieldName('name');
          const valueNode = declarator.childForFieldName('value');
          if (nameNode && valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
            const name = nameNode.text;
            const exported = isExported(node);
            symbols.push({
              name,
              kind: 'function',
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              signature: extractSignature(node, name, 'function'),
              docComment: getDocComment(node),
              isExported: exported,
              isDefault: isDefaultExport(node),
              parentName: currentClass,
            });
            const prevFunc = currentFunction;
            currentFunction = name;
            walkChildren(valueNode);
            currentFunction = prevFunc;
            return;
          }
        }
        break;
      }

      // === Classes ===
      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          symbols.push({
            name,
            kind: 'class',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSignature(node, name, 'class'),
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: isDefaultExport(node),
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

      // === Methods ===
      case 'method_definition':
      case 'public_field_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode && currentClass) {
          const name = nameNode.text;
          const kind: SymbolKind = node.type === 'method_definition' ? 'method' : 'variable';
          symbols.push({
            name,
            kind,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSignature(node, name, kind),
            docComment: getDocComment(node),
            isExported: false,
            isDefault: false,
            parentName: currentClass,
          });
          if (kind === 'method') {
            const prevFunc = currentFunction;
            currentFunction = `${currentClass}.${name}`;
            walkChildren(node);
            currentFunction = prevFunc;
            return;
          }
        }
        break;
      }

      // === Interfaces / Types ===
      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'interface',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: `interface ${nameNode.text}`,
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: false,
            parentName: null,
          });
        }
        break;
      }

      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'type',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: `type ${nameNode.text}`,
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: false,
            parentName: null,
          });
        }
        break;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'enum',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: `enum ${nameNode.text}`,
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: false,
            parentName: null,
          });
        }
        break;
      }

      // === Imports ===
      case 'import_statement': {
        const sourceNode = node.childForFieldName('source');
        if (sourceNode) {
          const sourcePath = sourceNode.text.replace(/['"]/g, '');
          const importedNames: string[] = [];
          let isDefault = false;
          let isNamespace = false;

          for (const child of node.namedChildren) {
            if (child.type === 'import_clause') {
              for (const c of child.namedChildren) {
                if (c.type === 'identifier') {
                  isDefault = true;
                  importedNames.push(c.text);
                } else if (c.type === 'named_imports') {
                  for (const spec of c.namedChildren) {
                    if (spec.type === 'import_specifier') {
                      const alias = spec.childForFieldName('alias');
                      const name = spec.childForFieldName('name');
                      importedNames.push(alias?.text ?? name?.text ?? spec.text);
                    }
                  }
                } else if (c.type === 'namespace_import') {
                  isNamespace = true;
                  const nameNode = c.namedChildren[0];
                  if (nameNode) importedNames.push(nameNode.text);
                }
              }
            }
          }

          imports.push({ sourcePath, importedNames, isDefault, isNamespace });
        }
        break;
      }

      // === Call expressions ===
      case 'call_expression': {
        if (currentFunction) {
          const funcNode = node.childForFieldName('function');
          if (funcNode) {
            let calleeName: string;
            if (funcNode.type === 'member_expression') {
              // obj.method() — extract method name
              const prop = funcNode.childForFieldName('property');
              calleeName = prop?.text ?? funcNode.text;
            } else {
              calleeName = funcNode.text;
            }
            // Skip built-ins and very long names
            if (calleeName.length < 100 && !calleeName.includes('(')) {
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
