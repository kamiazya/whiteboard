import ts from '@typescript/typescript6'

/**
 * Where a conjunction spells out "this box lies inside that one": two or more
 * comparisons of a FAR edge against a far edge (`a.x + a.width <= b.x + b.width`)
 * beside two or more of a near edge against a near edge (`a.x >= b.x`).
 *
 * Read from the syntax tree, not the text, because the rule is spelled with
 * whatever names the caller's boxes have — `node`/`group`, `n`/`movingNode`,
 * `r`/`bounds` — so no identifier is the thing to grep for.
 */
const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
])
const EXTENTS = new Set(['width', 'height', 'w', 'h'])

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node
}

const isAxisAccess = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node) && /^[xy]$/.test(node.name.text)

function isFarEdge(node: ts.Expression): boolean {
  const expr = unwrap(node)
  return (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    isAxisAccess(unwrap(expr.left)) &&
    ts.isPropertyAccessExpression(unwrap(expr.right)) &&
    EXTENTS.has((unwrap(expr.right) as ts.PropertyAccessExpression).name.text)
  )
}

function conjuncts(node: ts.Expression, out: ts.Expression[] = []): ts.Expression[] {
  const expr = unwrap(node)
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    conjuncts(expr.left, out)
    conjuncts(expr.right, out)
  } else {
    out.push(expr)
  }
  return out
}

const isAnd = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken

/** Whether one `&&` chain holds two near-edge and two far-edge comparisons. */
function spellsContainment(chain: ts.BinaryExpression): boolean {
  let near = 0
  let far = 0
  for (const part of conjuncts(chain)) {
    if (!ts.isBinaryExpression(part) || !COMPARISONS.has(part.operatorToken.kind)) continue
    if (isFarEdge(part.left) && isFarEdge(part.right)) far += 1
    else if (isAxisAccess(unwrap(part.left)) && isAxisAccess(unwrap(part.right))) near += 1
  }
  return near >= 2 && far >= 2
}

/** 1-based line of every `&&` chain that spells out box containment. */
export function containmentChains(fileName: string, source: string): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    // Only the outermost `&&` of a chain: its inner ones are parts of it.
    if (isAnd(node) && !isAnd(node.parent) && spellsContainment(node)) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}
