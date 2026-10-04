import ts from '@typescript/typescript6'
import { parseSource, unwrapExpression } from './ast-helpers.js'

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

type FunctionNode =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration

function enclosingFunction(node: ts.Node): FunctionNode | undefined {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n)
    ) {
      return n
    }
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

/** The ordering comparison a condition is, through parentheses and casts. */
const orderingOf = (node: ts.Expression): ts.BinaryExpression | undefined => {
  const expression = unwrapExpression(node)
  return ts.isBinaryExpression(expression) && ORDERING.has(expression.operatorToken.kind)
    ? expression
    : undefined
}

/** `a < b ? -1 : …`: the ternary that says which of two keys comes first. */
function isOrderingTernary(node: ts.Node): node is ts.ConditionalExpression {
  if (!ts.isConditionalExpression(node)) return false
  const condition = orderingOf(node.condition)
  return condition !== undefined && !hasLiteralOperand(condition) && isSign(node.whenTrue)
}

/** `return -1` or `return 1`, bare or as the one statement of a block. */
function returnsSign(statement: ts.Statement): boolean {
  const only =
    ts.isBlock(statement) && statement.statements.length === 1 ? statement.statements[0] : statement
  return (
    only !== undefined &&
    ts.isReturnStatement(only) &&
    only.expression !== undefined &&
    isSign(unwrapExpression(only.expression))
  )
}

/** `if (a < b) return -1`: the same question put as a statement. */
function isOrderingIf(node: ts.Node): node is ts.IfStatement {
  if (!ts.isIfStatement(node)) return false
  const condition = orderingOf(node.expression)
  return condition !== undefined && !hasLiteralOperand(condition) && returnsSign(node.thenStatement)
}

/**
 * Hand-written orderings inside a two-parameter comparator, which is the order
 * spelled out: an `a < b ? -1 : …` ternary (also when led by its tie,
 * `a === b ? 0 : a < b ? -1 : 1`), or the statement form (`if (a < b) return
 * -1; …`). A comparator counts once, however many links its chain has. A test that
 * yields a sign from a number (`cross > 0 ? 1 : -1`) is arithmetic, not an
 * order, and a function that is neither handed to a sort nor named like a
 * comparator (a method included) is not judged — a boundary a name cannot see
 * past. Read from the syntax tree so prose that quotes one is not a use.
 */
export function inlineComparators(fileName: string, source: string): number {
  const file = parseSource(fileName, source)
  const comparators = new Set<FunctionNode>()
  const visit = (node: ts.Node): void => {
    if (isOrderingTernary(node) || isOrderingIf(node)) {
      const fn = enclosingFunction(node)
      if (fn !== undefined && fn.parameters.length === 2 && isComparator(fn)) comparators.add(fn)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return comparators.size
}
