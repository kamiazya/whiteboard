import ts from '@typescript/typescript6'
import { parseSource } from './ast-helpers.js'

const ORDERING = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
])

/** `-1` or `1`, the two answers an ordering ternary gives. */
function isSign(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node)) return node.text === '1'
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand) &&
    node.operand.text === '1'
  )
}

/** The tail of a chain (`a < b ? -1 : a > b ? 1 : 0`) belongs to the ternary it hangs from. */
const isChainTail = (node: ts.Node): boolean =>
  node.parent !== undefined &&
  ts.isConditionalExpression(node.parent) &&
  node.parent.whenFalse === node

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration

function enclosingFunction(node: ts.Node): FunctionNode | undefined {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) return n
  }
  return undefined
}

const COMPARATOR_NAME = /^(by[A-Z]|compare|cmp)/

/** A function handed to `.sort` / `.toSorted`, or one named the way a comparator is. */
function isComparator(fn: FunctionNode): boolean {
  const parent = fn.parent
  if (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    (parent.expression.name.text === 'sort' || parent.expression.name.text === 'toSorted')
  ) {
    return true
  }
  const name = ts.isVariableDeclaration(parent) ? parent.name : fn.name
  return name !== undefined && ts.isIdentifier(name) && COMPARATOR_NAME.test(name.text)
}

/** `x < 0`: a sign test, which orders nothing. */
const hasLiteralOperand = (condition: ts.BinaryExpression): boolean =>
  ts.isNumericLiteral(condition.left) || ts.isNumericLiteral(condition.right)

/**
 * Hand-written orderings: an `a < b ? -1 : …` ternary inside a two-parameter
 * comparator, which is the order spelled out. A ternary that yields a sign
 * from a number (`cross > 0 ? 1 : -1`) is arithmetic, not an order, and a
 * function that is neither handed to a sort nor named like a comparator is
 * not judged — a boundary a name cannot see past. Read from the syntax tree so
 * prose that quotes one is not a use.
 */
export function inlineComparators(fileName: string, source: string): number {
  const file = parseSource(fileName, source)
  let found = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isConditionalExpression(node) &&
      !isChainTail(node) &&
      ts.isBinaryExpression(node.condition) &&
      ORDERING.has(node.condition.operatorToken.kind) &&
      !hasLiteralOperand(node.condition) &&
      isSign(node.whenTrue)
    ) {
      const fn = enclosingFunction(node)
      if (fn !== undefined && fn.parameters.length === 2 && isComparator(fn)) found += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
