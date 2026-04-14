import type Parser from 'web-tree-sitter';
import type { ParsedSymbol, ParsedImport, ParsedCallSite, SymbolKind } from '../../types.js';

export function extractPython(tree: Parser.Tree, source: string): {
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

  // Python: top-level and class-level defs are "exported" by default
  // __all__ would restrict this but we treat all top-level as exported

  function getDocstring(node: Parser.SyntaxNode): string | null {
    const body = node.childForFieldName('body');
    if (!body) return null;
    const first = body.namedChildren[0];
    if (first?.type === 'expression_statement') {
      const expr = first.namedChildren[0];
      if (expr?.type === 'string' || expr?.type === 'concatenated_string') {
        return expr.text;
      }
    }
    return null;
  }

  function getDecorators(node: Parser.SyntaxNode): string[] {
    const decorators: string[] = [];
    // Decorators are siblings before the definition in decorated_definition
    const parent = node.parent;
    if (parent?.type === 'decorated_definition') {
      for (const child of parent.namedChildren) {
        if (child.type === 'decorator') {
          decorators.push(child.text);
        }
      }
    }
    return decorators;
  }

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const isMethod = currentClass !== null;
          const isTopLevel = node.parent?.type === 'module' || node.parent?.type === 'decorated_definition' && node.parent.parent?.type === 'module';
          const decorators = getDecorators(node);
          const isStatic = decorators.some((d) => d.includes('staticmethod'));
          const isClassMethod = decorators.some((d) => d.includes('classmethod'));
          const isProperty = decorators.some((d) => d.includes('property'));

          const params = node.childForFieldName('parameters');
          const returnType = node.childForFieldName('return_type');
          let sig = `def ${name}(${params?.text ?? ''})`;
          if (returnType) sig += ` -> ${returnType.text}`;

          const kind: SymbolKind = isMethod ? 'method' : 'function';

          symbols.push({
            name,
            kind,
            lineStart: (node.parent?.type === 'decorated_definition' ? node.parent : node).startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: sig.length > 200 ? sig.slice(0, 200) + '...' : sig,
            docComment: getDocstring(node),
            isExported: !name.startsWith('_') && (isTopLevel || isMethod),
            isDefault: false,
            parentName: currentClass,
          });

          const prevFunc = currentFunction;
          currentFunction = currentClass ? `${currentClass}.${name}` : name;
          walkChildren(node);
          currentFunction = prevFunc;
          return;
        }
        break;
      }

      case 'class_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const superClasses = node.childForFieldName('superclasses');
          const sig = superClasses ? `class ${name}(${superClasses.text})` : `class ${name}`;

          symbols.push({
            name,
            kind: 'class',
            lineStart: (node.parent?.type === 'decorated_definition' ? node.parent : node).startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: sig,
            docComment: getDocstring(node),
            isExported: !name.startsWith('_'),
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

      // === Imports ===
      case 'import_statement': {
        // import foo, import foo as bar
        for (const child of node.namedChildren) {
          if (child.type === 'dotted_name' || child.type === 'aliased_import') {
            const name = child.type === 'aliased_import'
              ? (child.childForFieldName('alias')?.text ?? child.childForFieldName('name')?.text ?? child.text)
              : child.text;
            imports.push({
              sourcePath: child.type === 'aliased_import' ? (child.childForFieldName('name')?.text ?? child.text) : child.text,
              importedNames: [name],
              isDefault: true,
              isNamespace: true,
            });
          }
        }
        break;
      }

      case 'import_from_statement': {
        const moduleNode = node.childForFieldName('module_name');
        const sourcePath = moduleNode?.text ?? '';
        const importedNames: string[] = [];

        for (const child of node.namedChildren) {
          if (child.type === 'dotted_name' && child !== moduleNode) {
            importedNames.push(child.text);
          } else if (child.type === 'aliased_import') {
            const alias = child.childForFieldName('alias');
            const name = child.childForFieldName('name');
            importedNames.push(alias?.text ?? name?.text ?? child.text);
          } else if (child.type === 'wildcard_import') {
            importedNames.push('*');
          }
        }

        if (sourcePath) {
          imports.push({
            sourcePath,
            importedNames,
            isDefault: false,
            isNamespace: importedNames.includes('*'),
          });
        }
        break;
      }

      // === Call expressions ===
      case 'call': {
        if (currentFunction) {
          const funcNode = node.childForFieldName('function');
          if (funcNode) {
            let calleeName: string;
            if (funcNode.type === 'attribute') {
              const attr = funcNode.childForFieldName('attribute');
              calleeName = attr?.text ?? funcNode.text;
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

      // === Variable assignments at module level (constants) ===
      case 'expression_statement': {
        if (!currentFunction && !currentClass && node.parent?.type === 'module') {
          const assign = node.namedChildren[0];
          if (assign?.type === 'assignment') {
            const left = assign.childForFieldName('left');
            if (left?.type === 'identifier' && left.text === left.text.toUpperCase() && left.text.length > 1) {
              symbols.push({
                name: left.text,
                kind: 'constant',
                lineStart: node.startPosition.row + 1,
                lineEnd: node.endPosition.row + 1,
                signature: lines[node.startPosition.row]?.trim() ?? '',
                docComment: null,
                isExported: !left.text.startsWith('_'),
                isDefault: false,
                parentName: null,
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
