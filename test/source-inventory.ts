import ts from "typescript";
// Analyze every static import form, including side-effect imports and re-exports.
export function inventoryImports(source: string): string[] {
  const file = ts.createSourceFile(
      "inventory.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
    result: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec) {
        if (!ts.isStringLiteral(spec)) throw new Error("NON_LITERAL_IMPORT");
        result.push(spec.text);
      }
    }
    if (ts.isImportEqualsDeclaration(node))
      throw new Error("IMPORT_EQUALS_FORBIDDEN");
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      throw new Error("DYNAMIC_IMPORT_FORBIDDEN");
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}
