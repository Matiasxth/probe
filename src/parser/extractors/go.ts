import type Parser from 'web-tree-sitter';
import type { ParsedSymbol, ParsedImport, ParsedCallSite, SymbolKind } from '../../types.js';

export function extractGo(tree: Parser.Tree, source: string): {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  callSites: ParsedCallSite[];
} {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const callSites: ParsedCallSite[] = [];
  const lines = source.split('\n');

  let currentFunction: string | null = null;

  function getDocComment(node: Parser.SyntaxNode): string | null {
    const prev = node.previousNamedSibling;
    if (prev?.type === 'comment') return prev.text;
    return null;
  }

  // Go: exported = starts with uppercase
  function isGoExported(name: string): boolean {
    return name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
  }

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const params = node.childForFieldName('parameters');
          const result = node.childForFieldName('result');
          let sig = `func ${name}(${params?.text ?? ''})`;
          if (result) sig += ` ${result.text}`;

          symbols.push({
            name,
            kind: 'function',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: sig.length > 200 ? sig.slice(0, 200) + '...' : sig,
            docComment: getDocComment(node),
            isExported: isGoExported(name),
            isDefault: false,
            parentName: null,
          });

          const prevFunc = currentFunction;
          currentFunction = name;
          walkChildren(node);
          currentFunction = prevFunc;
          return;
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        const receiverNode = node.childForFieldName('receiver');
        if (nameNode) {
          const name = nameNode.text;
          let receiverType: string | null = null;

          if (receiverNode) {
            // Extract receiver type: (r *Type) or (r Type)
            const paramList = receiverNode.namedChildren;
            for (const p of paramList) {
              const typeNode = p.childForFieldName('type');
              if (typeNode) {
                receiverType = typeNode.text.replace('*', '');
                break;
              }
            }
          }

          const params = node.childForFieldName('parameters');
          const result = node.childForFieldName('result');
          let sig = `func (${receiverNode?.text ?? ''}) ${name}(${params?.text ?? ''})`;
          if (result) sig += ` ${result.text}`;

          symbols.push({
            name,
            kind: 'method',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: sig.length > 200 ? sig.slice(0, 200) + '...' : sig,
            docComment: getDocComment(node),
            isExported: isGoExported(name),
            isDefault: false,
            parentName: receiverType,
          });

          const prevFunc = currentFunction;
          currentFunction = receiverType ? `${receiverType}.${name}` : name;
          walkChildren(node);
          currentFunction = prevFunc;
          return;
        }
        break;
      }

      case 'type_declaration': {
        for (const spec of node.namedChildren) {
          if (spec.type === 'type_spec') {
            const nameNode = spec.childForFieldName('name');
            const typeNode = spec.childForFieldName('type');
            if (nameNode) {
              const name = nameNode.text;
              const isStruct = typeNode?.type === 'struct_type';
              const isInterface = typeNode?.type === 'interface_type';
              const kind: SymbolKind = isStruct ? 'class' : isInterface ? 'interface' : 'type';

              symbols.push({
                name,
                kind,
                lineStart: node.startPosition.row + 1,
                lineEnd: node.endPosition.row + 1,
                signature: `type ${name} ${typeNode?.type ?? ''}`.trim(),
                docComment: getDocComment(node),
                isExported: isGoExported(name),
                isDefault: false,
                parentName: null,
              });
            }
          }
        }
        break;
      }

      case 'const_declaration':
      case 'var_declaration': {
        for (const spec of node.namedChildren) {
          if (spec.type === 'const_spec' || spec.type === 'var_spec') {
            const nameNode = spec.childForFieldName('name');
            if (nameNode) {
              const name = nameNode.text;
              symbols.push({
                name,
                kind: node.type === 'const_declaration' ? 'constant' : 'variable',
                lineStart: spec.startPosition.row + 1,
                lineEnd: spec.endPosition.row + 1,
                signature: lines[spec.startPosition.row]?.trim() ?? '',
                docComment: getDocComment(node),
                isExported: isGoExported(name),
                isDefault: false,
                parentName: null,
              });
            }
          }
        }
        break;
      }

      // === Imports ===
      case 'import_declaration': {
        for (const spec of node.namedChildren) {
          if (spec.type === 'import_spec') {
            const pathNode = spec.childForFieldName('path');
            const aliasNode = spec.childForFieldName('name');
            if (pathNode) {
              const importPath = pathNode.text.replace(/"/g, '');
              const alias = aliasNode?.text;
              // Package name is last part of path
              const pkgName = alias ?? importPath.split('/').pop() ?? importPath;
              imports.push({
                sourcePath: importPath,
                importedNames: [pkgName],
                isDefault: false,
                isNamespace: true,
              });
            }
          } else if (spec.type === 'import_spec_list') {
            for (const child of spec.namedChildren) {
              if (child.type === 'import_spec') {
                const pathNode = child.childForFieldName('path');
                const aliasNode = child.childForFieldName('name');
                if (pathNode) {
                  const importPath = pathNode.text.replace(/"/g, '');
                  const alias = aliasNode?.text;
                  const pkgName = alias ?? importPath.split('/').pop() ?? importPath;
                  imports.push({
                    sourcePath: importPath,
                    importedNames: [pkgName],
                    isDefault: false,
                    isNamespace: true,
                  });
                }
              }
            }
          }
        }
        break;
      }

      // === Call expressions ===
      case 'call_expression': {
        if (currentFunction) {
          const funcNode = node.childForFieldName('function');
          if (funcNode) {
            let calleeName: string;
            if (funcNode.type === 'selector_expression') {
              const field = funcNode.childForFieldName('field');
              calleeName = field?.text ?? funcNode.text;
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
