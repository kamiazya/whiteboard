import ts from '@typescript/typescript6'
import { parseSource, unwrapExpression } from './ast-helpers.js'

/**
 * Where an object literal spells a box's top-right corner:
 * `{ x: box.x + box.width, y: box.y }`, in either key order, with or without
 * a `Math.round` around a coordinate.
 *
 * Read from the syntax tree because every copy named its box differently
 * (`node`, `target`, `region.rect`), so no identifier is the thing to grep
 * for. The base must be the same expression on all three reads, which keeps
 * `{ x: a.x + b.width, y: a.y }` (a corner of no box) out of the answer.
 */
function unwrapRound(node: ts.Expression): ts.Expression {
  const expr = unwrapExpression(node)
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === 'Math' &&
    expr.expression.name.text === 'round' &&
    expr.arguments.length === 1 &&
    expr.arguments[0] !== undefined
  ) {
    return unwrapExpression(expr.arguments[0])
  }
  return expr
}

const memberOf = (node: ts.Expression, name: string): ts.Expression | undefined => {
  const expr = unwrapRound(node)
  return ts.isPropertyAccessExpression(expr) && expr.name.text === name
    ? expr.expression
    : undefined
}

/** The base `b` of `b.x + b.width`, when that is what the expression is. */
function farEdgeBase(node: ts.Expression): ts.Expression | undefined {
  const expr = unwrapRound(node)
  if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
    return undefined
  }
  const left = memberOf(expr.left, 'x')
  const right = memberOf(expr.right, 'width')
  if (left === undefined || right === undefined) return undefined
  return left.getText() === right.getText() ? left : undefined
}

function initializerOf(
  literal: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      if (property.name.text === key) return property.initializer
    }
  }
  return undefined
}

/** 1-based line of every object literal that spells a box's top-right corner. */
export function topRightCornerLiterals(fileName: string, source: string): number[] {
  const file = parseSource(fileName, source)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const x = initializerOf(node, 'x')
      const y = initializerOf(node, 'y')
      const base = x === undefined ? undefined : farEdgeBase(x)
      const top = y === undefined ? undefined : memberOf(y, 'y')
      if (base !== undefined && top !== undefined && base.getText() === top.getText()) {
        lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}
