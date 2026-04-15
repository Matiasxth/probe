import type Parser from 'web-tree-sitter';
import type { ParsedSymbol, ParsedImport, ParsedCallSite, SymbolKind } from '../../types.js';

export function extractRuby(tree: Parser.Tree, source: string): {
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
  let visibility: 'public' | 'private' | 'protected' = 'public';

  function extractSig(node: Parser.SyntaxNode): string {
    const line = lines[node.startPosition.row]?.trim() ?? '';
    return line.length > 200 ? line.slice(0, 200) + '...' : line;
  }

  function getDocComment(node: Parser.SyntaxNode): string | null {
    const prev = node.previousNamedSibling;
    if (prev?.type === 'comment') return prev.text;
    return null;
  }

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      // === Methods ===
      case 'method': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const kind: SymbolKind = currentClass ? 'method' : 'function';
          symbols.push({
            name,
            kind,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: currentClass ? visibility === 'public' : true,
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

      // === Singleton methods (self.method) ===
      case 'singleton_method': {
        const nameNode = node.childForFieldName('name');
        if (nameNode && currentClass) {
          const name = nameNode.text;
          symbols.push({
            name,
            kind: 'method',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: extractSig(node),
            docComment: getDocComment(node),
            isExported: true,
            isDefault: false,
            parentName: currentClass,
          });
          const prevFunc = currentFunction;
          currentFunction = `${currentClass}.${name}`;
          walkChildren(node);
          currentFunction = prevFunc;
          return;
        }
        break;
      }

      // === Classes ===
      case 'class': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const superClass = node.childForFieldName('superclass');
          const sig = superClass ? `class ${name} < ${superClass.text}` : `class ${name}`;
          symbols.push({
            name,
            kind: 'class',
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: sig,
            docComment: getDocComment(node),
            isExported: true,
            isDefault: false,
            parentName: currentClass,
          });
          const prevClass = currentClass;
          const prevVis = visibility;
          currentClass = name;
          visibility = 'public';
          walkChildren(node);
          currentClass = prevClass;
          visibility = prevVis;
          return;
        }
        break;
      }

      // === Modules ===
      case 'module': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          symbols.push({
            name,
            kind: 'class', // Module acts as namespace/mixin
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            signature: `module ${name}`,
            docComment: getDocComment(node),
            isExported: true,
            isDefault: false,
            parentName: currentClass,
          });
          const prevClass = currentClass;
          currentClass = name;
          walkChildren(node);
          currentClass = prevClass;
          return;
        }
        break;
      }

      // === Visibility modifiers ===
      case 'identifier': {
        if (currentClass && !currentFunction) {
          if (node.text === 'private') visibility = 'private';
          else if (node.text === 'protected') visibility = 'protected';
          else if (node.text === 'public') visibility = 'public';
        }
        break;
      }

      // === Constants ===
      case 'assignment': {
        if (!currentFunction) {
          const left = node.childForFieldName('left');
          if (left?.type === 'constant') {
            symbols.push({
              name: left.text,
              kind: 'constant',
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              signature: extractSig(node),
              docComment: null,
              isExported: true,
              isDefault: false,
              parentName: currentClass,
            });
          }
        }
        break;
      }

      // === Require (imports) ===
      case 'call': {
        const methodNode = node.childForFieldName('method');
        const args = node.childForFieldName('arguments');

        // require / require_relative
        if (methodNode && (methodNode.text === 'require' || methodNode.text === 'require_relative')) {
          const firstArg = args?.namedChildren[0];
          if (firstArg?.type === 'string') {
            const path = firstArg.text.replace(/['"]/g, '');
            const isRelative = methodNode.text === 'require_relative';
            imports.push({
              sourcePath: isRelative ? `./${path}` : path,
              importedNames: [path.split('/').pop() ?? path],
              isDefault: true,
              isNamespace: true,
            });
          }
        }

        // Regular method calls
        if (currentFunction && methodNode) {
          let calleeName: string;
          let receiverName: string | undefined;

          if (methodNode.type === 'identifier') {
            calleeName = methodNode.text;
          } else {
            calleeName = methodNode.text;
          }

          const receiver = node.childForFieldName('receiver');
          if (receiver?.type === 'identifier' && receiver.text !== 'self') {
            receiverName = receiver.text;
          }

          if (calleeName.length < 100 && !['puts', 'print', 'p', 'pp', 'raise', 'require', 'require_relative', 'include', 'extend', 'attr_accessor', 'attr_reader', 'attr_writer', 'private', 'protected', 'public'].includes(calleeName)) {
            callSites.push({
              callerName: currentFunction,
              calleeName,
              ...(receiverName ? { receiverName } : {}),
              line: node.startPosition.row + 1,
            });
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
