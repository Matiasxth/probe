import type Parser from 'web-tree-sitter';
import type { ParsedSymbol, ParsedImport, ParsedCallSite, ParsedTypeHint, SymbolKind } from '../../types.js';

export function extractTypeScript(tree: Parser.Tree, source: string, isTsx: boolean = false): {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  callSites: ParsedCallSite[];
  typeHints: ParsedTypeHint[];
} {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const callSites: ParsedCallSite[] = [];
  const typeHints: ParsedTypeHint[] = [];
  const lines = source.split('\n');

  function getDocComment(node: Parser.SyntaxNode): string | null {
    // Check previous sibling of the node itself
    let prev = node.previousNamedSibling;
    if (prev?.type === 'comment') {
      const text = prev.text;
      if (text.startsWith('/**') || text.startsWith('//')) return text;
    }
    // For exported declarations, check previous sibling of the export_statement
    const parent = node.parent;
    if (parent?.type === 'export_statement') {
      prev = parent.previousNamedSibling;
      if (prev?.type === 'comment') {
        const text = prev.text;
        if (text.startsWith('/**') || text.startsWith('//')) return text;
      }
    }
    return null;
  }

  function getDecorators(node: Parser.SyntaxNode): string[] {
    const decorators: string[] = [];
    // In tree-sitter-typescript, decorators are children of the node itself
    for (const child of node.children) {
      if (child.type === 'decorator') {
        // Extract decorator text, truncate long ones
        const text = child.text.length > 80 ? child.text.slice(0, 80) + '...' : child.text;
        decorators.push(text);
      }
    }
    // Also check parent (for decorated classes/methods in some AST variants)
    const parent = node.parent;
    if (parent) {
      for (const child of parent.children) {
        if (child.type === 'decorator' && child.endPosition.row < node.startPosition.row) {
          const text = child.text.length > 80 ? child.text.slice(0, 80) + '...' : child.text;
          if (!decorators.includes(text)) decorators.push(text);
        }
      }
    }
    return decorators;
  }

  function detectTags(node: Parser.SyntaxNode, name: string, kind: string, isTsxFile: boolean): string[] {
    const tags: string[] = [];

    // Decorators → tags
    const decorators = getDecorators(node);
    tags.push(...decorators);

    // React component detection: PascalCase name + JSX in body or FC type
    if (kind === 'function' && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) {
      // Check for FC/FunctionComponent type annotation
      const typeNode = node.childForFieldName('type');
      if (typeNode) {
        const typeText = typeNode.text;
        if (typeText.includes('FC') || typeText.includes('FunctionComponent') || typeText.includes('ReactNode') || typeText.includes('JSX.Element')) {
          tags.push('component');
        }
      }
      // Check for JSX in body (for .tsx files)
      if (isTsxFile && !tags.includes('component')) {
        const hasJsx = containsJsx(node);
        if (hasJsx) tags.push('component');
      }
    }

    return tags;
  }

  function containsJsx(node: Parser.SyntaxNode): boolean {
    if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element' || node.type === 'jsx_fragment') {
      return true;
    }
    for (const child of node.children) {
      if (containsJsx(child)) return true;
    }
    return false;
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

  function extractReturnType(node: Parser.SyntaxNode): string | undefined {
    const retType = node.childForFieldName('return_type');
    if (!retType) return undefined;
    const text = retType.text.replace(/\s+/g, ' ').trim();
    // Extract the primary type: Promise<User> → User, Result<User, Error> → User
    const stripped = text.replace(/^Promise<(.+)>$/, '$1').replace(/^Result<(.+?),.+>$/, '$1');
    if (stripped.length < 50 && /^[A-Z]/.test(stripped)) return stripped;
    return undefined;
  }

  function extractParamTypeHints(funcNode: Parser.SyntaxNode, funcName: string): void {
    const params = funcNode.childForFieldName('parameters');
    if (!params) return;
    for (const param of params.namedChildren) {
      if (param.type === 'required_parameter' || param.type === 'optional_parameter') {
        const paramName = param.childForFieldName('pattern') ?? param.childForFieldName('name');
        const typeNode = param.childForFieldName('type');
        if (paramName?.type === 'identifier' && typeNode) {
          const typeName = typeNode.text.replace(/\s+/g, ' ').split('<')[0].split('|')[0].trim();
          if (typeName && typeName.length < 50 && /^[A-Z]/.test(typeName)) {
            typeHints.push({
              scope: funcName,
              variableName: paramName.text,
              typeName,
              source: 'parameter',
            });
          }
        }
      }
    }
  }

  function extractVarTypeHint(declarator: Parser.SyntaxNode, scope: string): void {
    const nameNode = declarator.childForFieldName('name');
    const typeNode = declarator.childForFieldName('type');
    const valueNode = declarator.childForFieldName('value');

    if (nameNode?.type !== 'identifier') return;

    // const user: User = ...
    if (typeNode) {
      const typeName = typeNode.text.replace(/\s+/g, ' ').split('<')[0].split('|')[0].trim();
      if (typeName && typeName.length < 50 && /^[A-Z]/.test(typeName)) {
        typeHints.push({ scope, variableName: nameNode.text, typeName, source: 'annotation' });
      }
    }

    // const user = new User()
    if (valueNode?.type === 'new_expression') {
      const ctor = valueNode.childForFieldName('constructor');
      if (ctor) {
        const typeName = ctor.text.split('<')[0];
        if (typeName.length < 50 && /^[A-Z]/.test(typeName)) {
          typeHints.push({ scope, variableName: nameNode.text, typeName, source: 'constructor' });
        }
      }
    }
  }

  function walk(node: Parser.SyntaxNode): void {
    switch (node.type) {
      // === Functions ===
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const tags = detectTags(node, name, 'function', isTsx);
          const returnType = extractReturnType(node);
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
            tags: tags.length > 0 ? tags : undefined,
            returnType,
          });
          const prevFunc = currentFunction;
          currentFunction = name;
          // Extract parameter type hints
          extractParamTypeHints(node, name);
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
            // Check type annotation for FC detection
            const tags = detectTags(declarator, name, 'function', isTsx);
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
              tags: tags.length > 0 ? tags : undefined,
            });
            const prevFunc = currentFunction;
            currentFunction = name;
            walkChildren(valueNode);
            currentFunction = prevFunc;
            return;
          }

          // CJS: const X = require('./foo') or const { a, b } = require('./foo')
          if (nameNode && valueNode && valueNode.type === 'call_expression') {
            const fn = valueNode.childForFieldName('function');
            if (fn?.text === 'require') {
              const args = valueNode.childForFieldName('arguments');
              const firstArg = args?.namedChildren[0];
              if (firstArg?.type === 'string') {
                const sourcePath = firstArg.text.replace(/['"]/g, '');
                if (nameNode.type === 'identifier') {
                  // const X = require('./foo')
                  imports.push({ sourcePath, importedNames: [nameNode.text], isDefault: true, isNamespace: true });
                } else if (nameNode.type === 'object_pattern') {
                  // const { a, b } = require('./foo')
                  const names: string[] = [];
                  const origNames: Record<string, string> = {};
                  for (const prop of nameNode.namedChildren) {
                    if (prop.type === 'shorthand_property_identifier_pattern') {
                      names.push(prop.text);
                    } else if (prop.type === 'pair_pattern') {
                      const key = prop.childForFieldName('key');
                      const val = prop.childForFieldName('value');
                      const localName = val?.text ?? key?.text ?? prop.text;
                      const origName = key?.text ?? prop.text;
                      names.push(localName);
                      if (origName !== localName) origNames[localName] = origName;
                    }
                  }
                  const hasAliases = Object.keys(origNames).length > 0;
                  imports.push({ sourcePath, importedNames: names, ...(hasAliases ? { originalNames: origNames } : {}), isDefault: false, isNamespace: false });
                }
              }
            }
          }

          // Extract type hints from variable declarations
          const scope = currentFunction ?? '__module__';
          extractVarTypeHint(declarator, scope);
        }
        break;
      }

      // === Classes ===
      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const tags = detectTags(node, name, 'class', isTsx);
          // Extract implements clause
          const implInterfaces: string[] = [];
          for (const child of node.namedChildren) {
            if (child.type === 'class_heritage') {
              for (const clause of child.namedChildren) {
                if (clause.type === 'implements_clause') {
                  for (const typeNode of clause.namedChildren) {
                    const typeName = typeNode.text.split('<')[0].trim();
                    if (typeName) implInterfaces.push(typeName);
                  }
                }
              }
            }
          }
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
            tags: tags.length > 0 ? tags : undefined,
            implementsInterfaces: implInterfaces.length > 0 ? implInterfaces : undefined,
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
          const rawName = nameNode.text;
          // Strip # from private methods for call graph matching
          const name = rawName.startsWith('#') ? rawName.slice(1) : rawName;
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
          const originalNames: Record<string, string> = {};
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
                      const localName = alias?.text ?? name?.text ?? spec.text;
                      const origName = name?.text ?? spec.text;
                      importedNames.push(localName);
                      if (alias && origName !== localName) {
                        originalNames[localName] = origName;
                      }
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

          const hasAliases = Object.keys(originalNames).length > 0;
          imports.push({ sourcePath, importedNames, ...(hasAliases ? { originalNames } : {}), isDefault, isNamespace });
        }
        break;
      }

      // === Re-exports: export { foo, bar } from './module' ===
      case 'export_statement': {
        const sourceNode = node.childForFieldName('source');
        if (sourceNode) {
          // This is a re-export: export { X } from './foo' or export * from './foo'
          const sourcePath = sourceNode.text.replace(/['"]/g, '');
          const importedNames: string[] = [];
          let isNamespace = false;

          for (const child of node.namedChildren) {
            if (child.type === 'export_clause') {
              for (const spec of child.namedChildren) {
                if (spec.type === 'export_specifier') {
                  const name = spec.childForFieldName('name');
                  const alias = spec.childForFieldName('alias');
                  importedNames.push(alias?.text ?? name?.text ?? spec.text);
                }
              }
            } else if (child.text === '*') {
              isNamespace = true;
            }
          }

          if (importedNames.length > 0 || isNamespace) {
            imports.push({ sourcePath, importedNames, isDefault: false, isNamespace });
          }
        }
        // Don't break — let it fall through to walkChildren for nested declarations
        break;
      }

      // === Call expressions ===
      case 'call_expression': {
        if (currentFunction) {
          const funcNode = node.childForFieldName('function');
          if (funcNode) {
            let calleeName: string;
            let receiverName: string | undefined;
            if (funcNode.type === 'member_expression') {
              const obj = funcNode.childForFieldName('object');
              const prop = funcNode.childForFieldName('property');
              calleeName = prop?.text ?? funcNode.text;
              if (calleeName.startsWith('#')) calleeName = calleeName.slice(1);
              // Capture receiver for type-aware resolution
              if (obj && obj.type === 'identifier' && obj.text !== 'this' && obj.text !== 'super') {
                receiverName = obj.text;
              }
            } else {
              calleeName = funcNode.text;
            }
            if (calleeName.length < 100 && !calleeName.includes('(')) {
              callSites.push({
                callerName: currentFunction,
                calleeName,
                ...(receiverName ? { receiverName } : {}),
                line: node.startPosition.row + 1,
              });
            }
          }

          // Scan arguments for function references (function-as-argument pattern)
          // e.g., app.get("/path", handler), emitter.on("event", callback)
          const argsNode = node.childForFieldName('arguments');
          if (argsNode) {
            for (const arg of argsNode.namedChildren) {
              if (arg.type === 'identifier' && arg.text.length > 1 && arg.text.length < 60) {
                // Skip common non-function arguments
                const skip = new Set(['true', 'false', 'null', 'undefined', 'this', 'self',
                  'data', 'value', 'result', 'err', 'error', 'ctx', 'req', 'res',
                  'options', 'config', 'params', 'args', 'props', 'state', 'key',
                  'index', 'item', 'name', 'type', 'path', 'url', 'msg', 'message']);
                if (!skip.has(arg.text)) {
                  callSites.push({
                    callerName: currentFunction,
                    calleeName: arg.text,
                    line: node.startPosition.row + 1,
                  });
                }
              }
            }
          }
        }
        break;
      }

      // === Constructor calls: new Foo() ===
      case 'new_expression': {
        if (currentFunction) {
          const ctorNode = node.childForFieldName('constructor');
          if (ctorNode) {
            const calleeName = ctorNode.text;
            if (calleeName.length < 100 && /^[A-Z]/.test(calleeName)) {
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

      // === CJS: module.exports / exports.X ===
      case 'expression_statement': {
        const expr = node.namedChildren[0];
        if (expr?.type === 'assignment_expression') {
          const left = expr.childForFieldName('left');
          if (left?.type === 'member_expression') {
            const obj = left.childForFieldName('object');
            const prop = left.childForFieldName('property');
            // module.exports = X → mark X as default export
            if (obj?.text === 'module' && prop?.text === 'exports') {
              const right = expr.childForFieldName('right');
              if (right?.type === 'identifier') {
                // Find the symbol and mark it as exported
                const sym = symbols.find((s) => s.name === right.text);
                if (sym) { sym.isExported = true; sym.isDefault = true; }
              }
            }
            // exports.foo = ... → mark foo as exported
            if (obj?.text === 'exports' && prop) {
              const existing = symbols.find((s) => s.name === prop.text);
              if (existing) { existing.isExported = true; }
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
  return { symbols, imports, callSites, typeHints };
}
