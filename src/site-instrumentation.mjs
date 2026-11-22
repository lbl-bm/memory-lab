import { createHash } from 'node:crypto';

// The build caller supplies its parser. CLI evidence analysis does not load TypeScript.
export function instrumentSourceSites(ts, source, filename, operations = ['subscribe', 'unsubscribe']) {
  const binding = '__memoryLabProbe', selected = new Set(operations);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(filename) ? ts.ScriptKind.TSX : /\.ts$/i.test(filename) ? ts.ScriptKind.TS : /\.jsx$/i.test(filename) ? ts.ScriptKind.JSX : ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw Error('invalid-source');
  const sourceSha256 = hash(source), sites = [], skipped = [];
  function check(node) {
    if (ts.isIdentifier(node) && node.text === binding) throw Error('reserved-probe-binding');
    ts.forEachChild(node, check);
  }
  check(file);
  const result = ts.transform(file, [context => {
    const f = context.factory;
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const access = node.expression;
        const property = ts.isPropertyAccessExpression(access) ? access.name.text
          : ts.isElementAccessExpression(access) && ts.isStringLiteral(access.argumentExpression) ? access.argumentExpression.text : null;
        if (selected.has(property)) {
          const start = node.getStart(file), position = file.getLineAndCharacterOfPosition(start);
          const location = { start, end: node.end, line: position.line + 1, column: position.character + 1, operation: property };
          if (!ts.isPropertyAccessExpression(access) || ts.isOptionalChain(node) || ts.isOptionalChain(access) || access.expression.kind === ts.SyntaxKind.SuperKeyword) {
            skipped.push({ ...location, reason: 'computed-optional-or-super-call' });
          } else {
            const id = hash(JSON.stringify([filename, sourceSha256, start, node.end, property])).slice(0, 24);
            sites.push({ id, ...location });
            const prepare = f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier(binding), 'prepare'), undefined,
              [f.createStringLiteral(id), ts.visitNode(access.expression, visit), f.createStringLiteral(property)]);
            return f.createCallExpression(prepare, undefined, node.arguments.map(arg => ts.visitNode(arg, visit)));
          }
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return root => ts.visitNode(root, visit);
  }]);
  let code;
  try { code = `const ${binding} = globalThis.${binding};\n` + ts.createPrinter().printFile(result.transformed[0]); }
  finally { result.dispose(); }
  sites.sort((a, b) => a.start - b.start);
  return { code, registry: { schemaVersion: '0.1.0', filename, sourceSha256, coordinateUnits: '1-based UTF-16 line/column; 0-based UTF-16 offsets', sites, skipped, operations, scope: 'Explicitly selected JS/TS/JSX/TSX module and direct method calls only; aliases, eval and dynamic property calls are outside coverage.' } };
}
