import ts from '@typescript/typescript6'
import { isTypeOnlyWrapper, parseSource, unwrapExpression } from './ast-helpers.js'

/**
 * Where a chain spells out "this box lies inside that one": two or more
 * comparisons of a FAR edge against a far edge (`a.x + a.width <= b.x + b.width`)
 * beside two or more of a near edge against a near edge (`a.x >= b.x`). The
 * chain is a conjunction, or its De Morgan form, the disjunction that says the
 * box does NOT lie inside (`a.x < b.x || ...`), and the comparisons may be
 * strict or inclusive: a copy of the rule is a copy whichever edge it counts.
 *
 * Read from the syntax tree, not the text, because the rule is spelled with
 * whatever names the caller's boxes have — `node`/`group`, `n`/`movingNode`,
 * `r`/`bounds` — so no identifier is the thing to grep for.
 */
const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
])
const CHAIN_OPERATORS = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken])
const EXTENTS = new Set(['width', 'height', 'w', 'h'])

const isAxisAccess = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node) && /^[xy]$/.test(node.name.text)

function isFarEdge(node: ts.Expression): boolean {
  const expr = unwrapExpression(node)
  return (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    isAxisAccess(unwrapExpression(expr.left)) &&
    ts.isPropertyAccessExpression(unwrapExpression(expr.right)) &&
    EXTENTS.has((unwrapExpression(expr.right) as ts.PropertyAccessExpression).name.text)
  )
}

/** The operands of one chain of `operator`, through parentheses and casts. */
function operands(
  node: ts.Expression,
  operator: ts.SyntaxKind,
  out: ts.Expression[] = [],
): ts.Expression[] {
  const expr = unwrapExpression(node)
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === operator) {
    operands(expr.left, operator, out)
    operands(expr.right, operator, out)
  } else {
    out.push(expr)
  }
  return out
}

const isChain = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && CHAIN_OPERATORS.has(node.operatorToken.kind)

/** Whether `node` is an operand of a larger chain of the same operator, however wrapped. */
function isInnerOfChain(node: ts.BinaryExpression): boolean {
  let parent: ts.Node = node.parent
  while (isTypeOnlyWrapper(parent)) parent = parent.parent
  return isChain(parent) && parent.operatorToken.kind === node.operatorToken.kind
}

/** Whether one chain holds two near-edge and two far-edge comparisons. */
function spellsContainment(chain: ts.BinaryExpression): boolean {
  let near = 0
  let far = 0
  for (const part of operands(chain, chain.operatorToken.kind)) {
    if (!ts.isBinaryExpression(part) || !COMPARISONS.has(part.operatorToken.kind)) continue
    if (isFarEdge(part.left) && isFarEdge(part.right)) far += 1
    else if (
      isAxisAccess(unwrapExpression(part.left)) &&
      isAxisAccess(unwrapExpression(part.right))
    )
      near += 1
  }
  return near >= 2 && far >= 2
}

/** 1-based line of every `&&` or `||` chain that spells out box containment. */
export function containmentChains(fileName: string, source: string): number[] {
  const file = parseSource(fileName, source)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    // Only the outermost link of a chain: its inner ones are parts of it.
    if (isChain(node) && !isInnerOfChain(node) && spellsContainment(node)) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}
