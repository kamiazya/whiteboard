import ts from '@typescript/typescript6'
import { isTypeOnlyWrapper, parseSource, unwrapExpression } from './ast-helpers.js'

/**
 * Where code spells out "all four of this box's coordinates are finite" over
 * the model's `{x, y, width, height}` shape: a `&&` chain holding
 * `Number.isFinite` of `r.x`, `r.y`, `r.width` and `r.height` for one
 * receiver `r` (other conjuncts beside them do not hide it), or
 * `[r.x, r.y, r.width, r.height].every(Number.isFinite)`.
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

/** `receiver.field` as `[receiverText, field]` when `field` is a rect coordinate. */
function rectField(node: ts.Expression, file: ts.SourceFile): [string, string] | undefined {
  const expr = unwrapExpression(node)
  if (!ts.isPropertyAccessExpression(expr)) return undefined
  const field = expr.name.text
  if (!(FIELDS as readonly string[]).includes(field)) return undefined
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

function conjuncts(node: ts.Expression, out: ts.Expression[] = []): ts.Expression[] {
  const expr = unwrapExpression(node)
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

const isAndChain = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken

function isInnerOfChain(node: ts.BinaryExpression): boolean {
  let parent: ts.Node = node.parent
  while (isTypeOnlyWrapper(parent)) parent = parent.parent
  return isAndChain(parent)
}

function chainSpellsFiniteRect(chain: ts.BinaryExpression, file: ts.SourceFile): boolean {
  const fields: [string, string][] = []
  for (const part of conjuncts(chain)) {
    if (!ts.isCallExpression(part) || part.arguments.length !== 1) continue
    if (!isNumberIsFinite(part.expression)) continue
    const field = rectField(part.arguments[0] as ts.Expression, file)
    if (field !== undefined) fields.push(field)
  }
  return coversARect(fields)
}

function everySpellsFiniteRect(call: ts.CallExpression, file: ts.SourceFile): boolean {
  const callee = unwrapExpression(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'every') return false
  if (call.arguments.length !== 1 || !isNumberIsFinite(call.arguments[0] as ts.Expression))
    return false
  const list = unwrapExpression(callee.expression)
  if (!ts.isArrayLiteralExpression(list)) return false
  const fields = list.elements
    .map((element) => rectField(element, file))
    .filter((field): field is [string, string] => field !== undefined)
  return coversARect(fields)
}

/** 1-based line of every expression that spells out "this rect is finite". */
export function finiteRectChecks(fileName: string, source: string): number[] {
  const file = parseSource(fileName, source)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    const hit =
      (isAndChain(node) && !isInnerOfChain(node) && chainSpellsFiniteRect(node, file)) ||
      (ts.isCallExpression(node) && everySpellsFiniteRect(node, file))
    if (hit) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}
