import type Parser from 'web-tree-sitter';
import type { ParsedSymbol, ParsedImport, ParsedCallSite, SymbolKind } from '../../types.js';

export function extractJava(tree: Parser.Tree, source: string): {
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
    const prev = node.previousNamedSibling;
    if (prev?.type === 'block_comment' || prev?.type === 'line_comment') {
      const text = prev.text;
      if (text.startsWith('/**') || text.startsWith('//')) return text;
    }
    return null;
  }

  function getVisibility(node: Parser.SyntaxNode): 'public' | 'protected' | 'private' | 'package' {
    for (const child of node.children) {
      if (child.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('protected')) return 'protected';
        if (text.includes('private')) return 'private';
      }
    }
    return 'package';
  }

  function isExported(node: Parser.SyntaxNode): boolean {
    const vis = getVisibility(node);
    return vis === 'public' || vis === 'protected';
  }

  function getAnnotations(node: Parser.SyntaxNode): string[] {
    const annotations: string[] = [];
    for (const child of node.children) {
      if (child.type === 'modifiers') {
        for (const mod of child.namedChildren) {
          if (mod.type === 'marker_annotation' || mod.type === 'annotation') {
            const text = mod.text.length > 80 ? mod.text.slice(0, 80) + '...' : mod.text;
            annotations.push(text);
          }
        }
      }
    }
    return annotations;
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
      // === Methods ===
      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const annotations = getAnnotations(node);
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
            tags: annotations.length > 0 ? annotations : undefined,
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
          const annotations = getAnnotations(node);
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
            tags: annotations.length > 0 ? annotations : undefined,
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
          const annotations = getAnnotations(node);
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
            tags: annotations.length > 0 ? annotations : undefined,
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

      // === Fields (constants: static final) ===
      case 'field_declaration': {
        if (currentClass) {
          const declarator = node.namedChildren.find((c) => c.type === 'variable_declarator');
          const nameNode = declarator?.childForFieldName('name');
          if (nameNode) {
            const modText = node.children.find((c) => c.type === 'modifiers')?.text ?? '';
            const isConst = modText.includes('static') && modText.includes('final');
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
        break;
      }

      // === Imports ===
      case 'import_declaration': {
        // import com.example.Foo; or import com.example.*;
        const pathNode = node.namedChildren.find((c) => c.type === 'scoped_identifier');
        if (pathNode) {
          const fullPath = pathNode.text;
          const parts = fullPath.split('.');
          const lastName = parts[parts.length - 1];
          const packagePath = parts.slice(0, -1).join('.');

          const isStatic = node.children.some((c) => c.text === 'static');
          imports.push({
            sourcePath: packagePath,
            importedNames: [lastName],
            isDefault: false,
            isNamespace: lastName === '*',
          });
        }
        break;
      }

      // === Call expressions ===
      case 'method_invocation': {
        if (currentFunction) {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            callSites.push({
              callerName: currentFunction,
              calleeName: nameNode.text,
              line: node.startPosition.row + 1,
            });
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
