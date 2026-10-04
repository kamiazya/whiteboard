import ts from '@typescript/typescript6'

/** The parser mode a file's extension asks for: JSX is legal only in `.tsx` / `.jsx`. */
export function scriptKindOf(fileName: string): ts.ScriptKind {
  return /\.[tj]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/**
 * An expression with the wrappers that change its type and not its value looked
 * through: parentheses, `as`, `satisfies`, `<T>x` and `x!`. A guard that
 * skipped only some would judge `(save as Fn)(doc)` as something other than
 * the call it is.
 */
export function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/**
 * Parse `text` the way its file name asks. Parent pointers are on because most
 * walks read `node.parent`; a scan that never does may pass `false`, since
 * they are most of the cost of a parse.
 */
export function parseSource(fileName: string, text: string, setParentNodes = true): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    setParentNodes,
    scriptKindOf(fileName),
  )
}
