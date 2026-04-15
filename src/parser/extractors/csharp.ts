import type Parser from 'web-tree-sitter';
import type { ParsedSymbol, ParsedImport, ParsedCallSite, SymbolKind } from '../../types.js';

export function extractCSharp(tree: Parser.Tree, source: string): {
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

  function getDocComment(node: Parser.SyntaxNode): string | null {
    // C# uses /// XML doc comments — collect consecutive comment lines above the node
    const startRow = node.startPosition.row;
    const commentLines: string[] = [];
    for (let i = startRow - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (line && (line.startsWith('///') || line.startsWith('///'))) {
        commentLines.unshift(line);
      } else {
        break;
      }
    }
    if (commentLines.length > 0) return commentLines.join('\n');

    // Fallback: check previous sibling for block comments
    const prev = node.previousNamedSibling;
    if (prev?.type === 'comment') return prev.text;
    return null;
  }

  function getVisibility(node: Parser.SyntaxNode): 'public' | 'protected' | 'private' | 'internal' {
    for (const child of node.children) {
      if (child.type === 'modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'protected') return 'protected';
        if (text === 'private') return 'private';
        if (text === 'internal') return 'internal';
      }
    }
    return 'private';
  }

  function isExported(node: Parser.SyntaxNode): boolean {
    const vis = getVisibility(node);
    return vis === 'public' || vis === 'protected';
  }

  function getAttributes(node: Parser.SyntaxNode): string[] {
    const attrs: string[] = [];
    // Attributes appear as attribute_list siblings before the declaration
    let sibling = node.previousNamedSibling;
    while (sibling) {
      if (sibling.type === 'attribute_list') {
        for (const attr of sibling.namedChildren) {
          if (attr.type === 'attribute') {
            const text = attr.text.length > 80 ? attr.text.slice(0, 80) + '...' : attr.text;
            attrs.unshift(`[${text}]`);
          }
        }
        sibling = sibling.previousNamedSibling;
      } else {
        break;
      }
    }
    return attrs;
  }

  function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
    for (const child of node.children) {
      if (child.type === 'modifier' && child.text === modifier) return true;
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

  function getReturnType(node: Parser.SyntaxNode): string | undefined {
    const typeNode = node.childForFieldName('type') ?? node.childForFieldName('returns');
    if (typeNode) {
      const text = typeNode.text;
      return text.length > 100 ? text.slice(0, 100) + '...' : text;
    }
    return undefined;
  }

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      // === Methods ===
      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const tags = getAttributes(node);
          const returnType = getReturnType(node);
          symbols.push({
            name,
            kind: 'method',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: false,
            parentName: currentClass,
            tags: tags.length > 0 ? tags : undefined,
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

      // === Constructors ===
      case 'constructor_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'method',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: false,
            parentName: currentClass,
          });
          const prevFunc = currentFunction;
          currentFunction = currentClass ? `${currentClass}.${nameNode.text}` : nameNode.text;
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
          const tags = getAttributes(node);
          symbols.push({
            name,
            kind: 'class',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: false,
            parentName: currentClass,
            tags: tags.length > 0 ? tags : undefined,
          });
          const prevClass = currentClass;
          currentClass = name;
          walkChildren(node);
          currentClass = prevClass;
          return;
        }
        break;
      }

      // === Structs ===
      case 'struct_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const tags = getAttributes(node);
          symbols.push({
            name,
            kind: 'class',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: false,
            parentName: currentClass,
            tags: tags.length > 0 ? tags : undefined,
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
          const tags = getAttributes(node);
          symbols.push({
            name: nameNode.text,
            kind: 'interface',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: isExported(node),
            isDefault: false,
            parentName: currentClass,
            tags: tags.length > 0 ? tags : undefined,
          });
          const prevClass = currentClass;
          currentClass = nameNode.text;
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
            isExported: isExported(node),
            isDefault: false,
            parentName: currentClass,
          });
        }
        break;
      }

      // === Properties ===
      case 'property_declaration': {
        if (currentClass) {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            const tags = getAttributes(node);
            const returnType = getReturnType(node);
            symbols.push({
              name: nameNode.text,
              kind: 'variable',
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              signature: lines[node.startPosition.row]?.trim() ?? '',
              docComment: getDocComment(node),
              isExported: isExported(node),
              isDefault: false,
              parentName: currentClass,
              tags: tags.length > 0 ? tags : undefined,
              returnType,
            });
          }
        }
        break;
      }

      // === Fields (const / static readonly = constant) ===
      case 'field_declaration': {
        if (currentClass) {
          const declarator = node.namedChildren.find((c) => c.type === 'variable_declaration');
          if (declarator) {
            for (const varDecl of declarator.namedChildren) {
              if (varDecl.type === 'variable_declarator') {
                const nameNode = varDecl.childForFieldName('name') ?? varDecl.namedChildren[0];
                if (nameNode && nameNode.type === 'identifier') {
                  const isConst = hasModifier(node, 'const') || (hasModifier(node, 'static') && hasModifier(node, 'readonly'));
                  symbols.push({
                    name: nameNode.text,
                    kind: isConst ? 'constant' : 'variable',
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
        }
        break;
      }

      // === Namespaces (act as scope containers) ===
      case 'namespace_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'class',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: `namespace ${nameNode.text}`,
            docComment: null,
            isExported: true,
            isDefault: false,
            parentName: null,
          });
        }
        walkChildren(node);
        return;
      }

      // === Imports (using directives) ===
      case 'using_directive': {
        // using System.Collections.Generic;  or  using Alias = Some.Namespace;
        const nameNode = node.childForFieldName('name') ?? node.namedChildren.find(
          (c) => c.type === 'qualified_name' || c.type === 'identifier',
        );
        if (nameNode) {
          const fullPath = nameNode.text;
          imports.push({
            sourcePath: fullPath,
            importedNames: [fullPath.split('.').pop() ?? fullPath],
            isDefault: false,
            isNamespace: true,
          });
        }
        break;
      }

      // === Call expressions ===
      case 'invocation_expression': {
        if (currentFunction) {
          const funcNode = node.childForFieldName('function') ?? node.namedChildren[0];
          if (funcNode) {
            let calleeName: string;
            if (funcNode.type === 'member_access_expression') {
              const nameChild = funcNode.childForFieldName('name');
              calleeName = nameChild?.text ?? funcNode.text;
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

      // === Object creation: new Foo() ===
      case 'object_creation_expression': {
        if (currentFunction) {
          const typeNode = node.childForFieldName('type');
          if (typeNode) {
            const name = typeNode.text.split('<')[0]; // Strip generics
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
