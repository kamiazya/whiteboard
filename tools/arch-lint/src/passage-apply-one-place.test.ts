/**
 * Adopting a batch of prose passages is read in ONE place: model's
 * `applyPassages`.
 *
 * The batch is placed against one read of the body and applied back to front,
 * which is equivalent to applying each passage to the body that was read only
 * while no two passages overlap. Two adopters spelled that sort-and-splice by
 * hand, and only one of them refused an overlap — the other wrote text neither
 * change proposed, and every test that used disjoint passages stayed green.
 *
 * The single splice is not exported, so the compiler already keeps a second
 * adopter from reducing with it. What it cannot see is the splice written
 * again, and the shape that betrays one is the order it has to apply in: a
 * comparator putting the LATER start first (`(a, b) => b.….start -
 * a.….start`). Read off the syntax tree, any parameter names, through `sort`
 * or `toSorted`, an arrow or a function, a parameter destructured
 * (`({ at: a }, { at: b }) => b.start - a.start`, or down to the start
 * itself), and a difference that leads a tie-break (`… || 0`, `… ?? 0`). Not
 * seen: an ascending sort followed by `reverse()`, a negated comparator, or
 * one passed by name.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource, unwrapExpression } from './ast-helpers.js'
import { countNamedUses } from './named-use-scan.js'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

/** Where the batch lives. Exempt by construction: it IS the place. */
const OWNER = 'packages/model/src/proposal-apply.ts'

const files: string[] = []
for (const root of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, root), files)
const production = files
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))

/**
 * What one comparator parameter binds: `roots`, the names a `x.….start` chain
 * may be rooted at (the parameter itself, or any name destructured out of
 * it), and `starts`, the names destructured straight from a `start` key.
 */
interface Bound {
  readonly roots: ReadonlySet<string>
  readonly starts: ReadonlySet<string>
}

function boundBy(name: ts.BindingName): Bound {
  const roots = new Set<string>()
  const starts = new Set<string>()
  const visit = (binding: ts.BindingName, key: string | undefined): void => {
    if (ts.isIdentifier(binding)) {
      roots.add(binding.text)
      if (key === 'start') starts.add(binding.text)
      return
    }
    for (const element of binding.elements) {
      if (ts.isOmittedExpression(element)) continue
      const property = element.propertyName ?? element.name
      visit(element.name, ts.isIdentifier(property) ? property.text : undefined)
    }
  }
  visit(name, undefined)
  return { roots, starts }
}

/** Whether `raw` reads a start out of what `bound` binds: `x.….start`, or a destructured `start`. */
function readsStart(raw: ts.Expression, bound: Bound): boolean {
  const node = unwrapExpression(raw)
  if (ts.isIdentifier(node)) return bound.starts.has(node.text)
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'start') return false
  let root: ts.Expression = node.expression
  while (ts.isPropertyAccessExpression(root)) root = root.expression
  return ts.isIdentifier(root) && bound.roots.has(root.text)
}

/** The expression a comparator answers with, for an arrow body or a lone `return`. */
function answerOf(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression | undefined {
  if (!ts.isBlock(fn.body)) return fn.body
  const [only] = fn.body.statements
  return fn.body.statements.length === 1 && only !== undefined && ts.isReturnStatement(only)
    ? only.expression
    : undefined
}

/** The difference that decides the order: the answer itself, or what leads its tie-breaks. */
function leadingTerm(raw: ts.Expression): ts.Expression {
  let node = unwrapExpression(raw)
  while (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    node = unwrapExpression(node.left)
  }
  return node
}

function isDescendingStartSort(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  if (!['sort', 'toSorted'].includes(node.expression.name.text)) return false
  const [comparator] = node.arguments
  if (comparator === undefined) return false
  const fn = unwrapExpression(comparator)
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  const [first, second] = fn.parameters
  if (first === undefined || second === undefined) return false
  const answer = answerOf(fn)
  if (answer === undefined) return false
  const body = leadingTerm(answer)
  return (
    ts.isBinaryExpression(body) &&
    body.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    readsStart(body.left, boundBy(second.name)) &&
    readsStart(body.right, boundBy(first.name))
  )
}

/** Sorts in a source, read off the syntax tree only when the text could hold one. */
function descendingStartSorts(source: string, fileName = 'fixture.ts'): number {
  // `start`, not `.start`: a destructured start is spelled without the dot.
  if (!source.includes('start')) return 0
  const file = parseSource(fileName, source)
  let count = 0
  const visit = (node: ts.Node): void => {
    if (isDescendingStartSort(node)) count += 1
    ts.forEachChild(node, visit)
  }
  visit(file)
  return count
}

function sortsIn(path: string): number {
  return descendingStartSorts(readFileSync(path, 'utf8'), path)
}

const FIXTURES: readonly { readonly source: string; readonly sorts: number }[] = [
  { source: 'placed.sort((a, b) => b.at.start - a.at.start)', sorts: 1 },
  { source: '[...placed]\n  .sort((left, right) => right.start - left.start)', sorts: 1 },
  { source: 'placed.toSorted((a, b) => (b.range.start - a.range.start))', sorts: 1 },
  { source: 'placed.sort(function (a, b) { return b.at.start - a.at.start })', sorts: 1 },
  { source: 'placed.sort((a, b) => a.at.start - b.at.start)', sorts: 0 },
  { source: 'placed.sort((a, b) => b.at.end - a.at.end)', sorts: 0 },
  { source: 'placed.sort((a, b) => b.at.start - other.start)', sorts: 0 },
  { source: '// placed.sort((a, b) => b.at.start - a.at.start)', sorts: 0 },
  { source: 'placed.sort(({ at: a }, { at: b }) => b.start - a.start)', sorts: 1 },
  { source: 'placed.sort(({ at }, { at: other }) => other.start - at.start)', sorts: 1 },
  { source: 'placed.sort(({ at: { start: a } }, { at: { start: b } }) => b - a)', sorts: 1 },
  { source: 'placed.sort(({ start: a }, { start: b }) => b - a)', sorts: 1 },
  { source: 'placed.sort((a, b) => b.at.start - a.at.start || 0)', sorts: 1 },
  { source: 'placed.sort((a, b) => (b.at.start - a.at.start) ?? b.at.end - a.at.end)', sorts: 1 },
  { source: 'placed.sort(({ at: a }, { at: b }) => a.start - b.start)', sorts: 0 },
  { source: 'placed.sort(({ end: a }, { end: b }) => b - a)', sorts: 0 },
  { source: 'placed.sort((a, b) => b.at.end - a.at.end || b.at.start - a.at.start)', sorts: 0 },
  { source: 'placed.sort((a, b) => b.at.start - a.at.start && 0)', sorts: 0 },
]

describe('a batch of passages is applied in one place', () => {
  it('recognises a descending-start comparator however it is spelled, and not its neighbours', () => {
    for (const { source, sorts } of FIXTURES) {
      expect(descendingStartSorts(source), source).toBe(sorts)
    }
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(1000)
    expect(production.some(({ rel }) => rel === OWNER)).toBe(true)
  })

  it('no production file outside model orders passages to splice them by hand', () => {
    const hits = production
      .filter(({ rel }) => rel !== OWNER)
      .filter(({ path }) => sortsIn(path) > 0)
      .map(({ rel }) => rel)
    expect(
      hits,
      'adopt through `applyPassages` from @kamiazya/whiteboard-model: it refuses passages that overlap, which a hand-written back-to-front splice silently corrupts',
    ).toEqual([])
  })

  it('the owner still orders its batch so, and both adopters go through it', () => {
    // A zero on the left would mean the batch moved and this guards a module
    // that no longer holds it; fewer than two adopters would mean one of them
    // found another way.
    expect(sortsIn(join(REPO_ROOT, OWNER))).toBe(1)
    const adopters = production
      .filter(({ rel }) => rel !== OWNER)
      .filter(({ path }) => {
        const source = readFileSync(path, 'utf8')
        return (
          source.includes('applyPassages') && countNamedUses(path, source, ['applyPassages']) > 0
        )
      })
      .map(({ rel }) => rel)
    expect(adopters.sort()).toEqual([
      'apps/web/src/lib/apply-adopted-passages.ts',
      'packages/server-core/src/tools/body-edit.ts',
    ])
  })
})
