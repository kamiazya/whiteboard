import ts from '@typescript/typescript6'
import { isTypeOnlyWrapper, parseSource, unwrapExpression } from './ast-helpers.js'

/**
 * Where code spells out "all four of this box's coordinates are finite" over
 * the model's `{x, y, width, height}` shape, in any of the spellings the rule
 * is naturally written in:
 *
 * - a `&&` chain holding `Number.isFinite` of `r.x`, `r.y`, `r.width` and
 *   `r.height` for one receiver `r` (other conjuncts beside them do not hide
 *   it), and its De Morgan form, a `||` chain of `!Number.isFinite(r.x)` and
 *   the rest;
 * - `[r.x, r.y, r.width, r.height].every(Number.isFinite)`, the same with
 *   `(v) => Number.isFinite(v)`, and `.some((v) => !Number.isFinite(v))`.
 *
 * Bare identifiers named `x`, `y`, `width` and `height` count as one receiver
 * too, so the check is found on a box destructured or rounded into locals
 * first. Bare `isFinite` counts as `Number.isFinite`.
 *
 * Not matched, deliberately: a predicate other than the finiteness test
 * (`Number.isNaN`, a `typeof` check), a list built anywhere but in place, and
 * four separate statements — each is a different rule or no longer one
 * expression to point at.
 *
 * Read from the syntax tree because each copy names its box differently —
 * `box`, `n`, `next` — so no identifier is the thing to grep for. The scene's
 * `{x, y, w, h}` box is a different shape with its own predicate and is not
 * matched.
 */
const FIELDS = ['x', 'y', 'width', 'height'] as const

const isNumberIsFinite = (node: ts.Expression): boolean => {
  const expr = unwrapExpression(node)
  return (
    (ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'Number' &&
      expr.name.text === 'isFinite') ||
    (ts.isIdentifier(expr) && expr.text === 'isFinite')
  )
}

const isField = (name: string): boolean => (FIELDS as readonly string[]).includes(name)

/**
 * `receiver.field` as `[receiverText, field]` when `field` is a rect
 * coordinate, and a bare local of a coordinate's name as `['', name]`.
 */
function rectField(node: ts.Expression, file: ts.SourceFile): [string, string] | undefined {
  const expr = unwrapExpression(node)
  if (ts.isIdentifier(expr)) return isField(expr.text) ? ['', expr.text] : undefined
  if (!ts.isPropertyAccessExpression(expr)) return undefined
  const field = expr.name.text
  if (!isField(field)) return undefined
  return [unwrapExpression(expr.expression).getText(file), field]
}

/** Whether `fields` (receiver, field pairs) covers all four for some receiver. */
function coversARect(fields: readonly [string, string][]): boolean {
  const byReceiver = new Map<string, Set<string>>()
  for (const [receiver, field] of fields) {
    const seen = byReceiver.get(receiver) ?? new Set<string>()
    seen.add(field)
    byReceiver.set(receiver, seen)
  }
  return [...byReceiver.values()].some((seen) => FIELDS.every((field) => seen.has(field)))
}

type ChainOperator = ts.SyntaxKind.AmpersandAmpersandToken | ts.SyntaxKind.BarBarToken

const isChain = (node: ts.Node, operator: ChainOperator): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === operator

function operands(node: ts.Expression, operator: ChainOperator, out: ts.Expression[] = []) {
  const expr = unwrapExpression(node)
  if (isChain(expr, operator)) {
    operands(expr.left, operator, out)
    operands(expr.right, operator, out)
  } else {
    out.push(expr)
  }
  return out
}

function isInnerOfChain(node: ts.BinaryExpression, operator: ChainOperator): boolean {
  let parent: ts.Node = node.parent
  while (isTypeOnlyWrapper(parent)) parent = parent.parent
  return isChain(parent, operator)
}

/** `isFinite(arg)` as `arg`, or `!isFinite(arg)` when `negated`. */
function finiteArgument(node: ts.Expression, negated: boolean): ts.Expression | undefined {
  let expr = unwrapExpression(node)
  if (negated) {
    if (!ts.isPrefixUnaryExpression(expr) || expr.operator !== ts.SyntaxKind.ExclamationToken)
      return undefined
    expr = unwrapExpression(expr.operand)
  }
  if (!ts.isCallExpression(expr) || expr.arguments.length !== 1) return undefined
  if (!isNumberIsFinite(expr.expression)) return undefined
  return expr.arguments[0]
}

/** `&&` of `isFinite(r.f)`, or `||` of `!isFinite(r.f)`, over all four fields. */
function chainSpellsFiniteRect(
  chain: ts.BinaryExpression,
  operator: ChainOperator,
  file: ts.SourceFile,
): boolean {
  const negated = operator === ts.SyntaxKind.BarBarToken
  const fields: [string, string][] = []
  for (const part of operands(chain, operator)) {
    const argument = finiteArgument(part, negated)
    const field = argument === undefined ? undefined : rectField(argument, file)
    if (field !== undefined) fields.push(field)
  }
  return coversARect(fields)
}

/** The single expression an arrow or function returns, if that is all it does. */
function returnedExpression(fn: ts.ArrowFunction | ts.FunctionExpression) {
  if (ts.isExpression(fn.body)) return fn.body
  const [only] = fn.body.statements
  if (fn.body.statements.length !== 1 || only === undefined) return undefined
  return ts.isReturnStatement(only) ? only.expression : undefined
}

/**
 * Whether `callback` tests its one argument for finiteness: `Number.isFinite`
 * itself, or a one-parameter function returning `isFinite(v)` — `!isFinite(v)`
 * when `negated`, the `.some` form.
 */
function testsFiniteness(callback: ts.Expression, negated: boolean): boolean {
  const expr = unwrapExpression(callback)
  if (!negated && isNumberIsFinite(expr)) return true
  if (!ts.isArrowFunction(expr) && !ts.isFunctionExpression(expr)) return false
  const [param] = expr.parameters
  if (expr.parameters.length !== 1 || param === undefined || !ts.isIdentifier(param.name))
    return false
  const body = returnedExpression(expr)
  const argument = body === undefined ? undefined : finiteArgument(body, negated)
  if (argument === undefined) return false
  const arg = unwrapExpression(argument)
  return ts.isIdentifier(arg) && arg.text === param.name.text
}

function listSpellsFiniteRect(call: ts.CallExpression, file: ts.SourceFile): boolean {
  const callee = unwrapExpression(call.expression)
  if (!ts.isPropertyAccessExpression(callee)) return false
  const method = callee.name.text
  if (method !== 'every' && method !== 'some') return false
  const [callback] = call.arguments
  if (call.arguments.length !== 1 || callback === undefined) return false
  if (!testsFiniteness(callback, method === 'some')) return false
  const list = unwrapExpression(callee.expression)
  if (!ts.isArrayLiteralExpression(list)) return false
  const fields = list.elements
    .map((element) => rectField(element, file))
    .filter((field): field is [string, string] => field !== undefined)
  return coversARect(fields)
}

const CHAINS: readonly ChainOperator[] = [
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
]

/** 1-based line of every expression that spells out "this rect is finite". */
export function finiteRectChecks(fileName: string, source: string): number[] {
  const file = parseSource(fileName, source)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    const hit =
      CHAINS.some(
        (operator) =>
          isChain(node, operator) &&
          !isInnerOfChain(node, operator) &&
          chainSpellsFiniteRect(node, operator, file),
      ) ||
      (ts.isCallExpression(node) && listSpellsFiniteRect(node, file))
    if (hit) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}
