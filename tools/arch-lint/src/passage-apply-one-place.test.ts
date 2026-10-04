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
 * or `toSorted`, an arrow or a function. Not seen: an ascending sort followed
 * by `reverse()`, a negated comparator, or one passed by name.
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

/** The identifier a `x.y.start` chain is rooted at, when it ends in `.start`. */
function startRoot(raw: ts.Expression): string | undefined {
  const node = unwrapExpression(raw)
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'start') return undefined
  let root: ts.Expression = node.expression
  while (ts.isPropertyAccessExpression(root)) root = root.expression
  return ts.isIdentifier(root) ? root.text : undefined
}

/** The expression a comparator answers with, for an arrow body or a lone `return`. */
function answerOf(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression | undefined {
  if (!ts.isBlock(fn.body)) return fn.body
  const [only] = fn.body.statements
  return fn.body.statements.length === 1 && only !== undefined && ts.isReturnStatement(only)
    ? only.expression
    : undefined
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
  if (!ts.isIdentifier(first.name) || !ts.isIdentifier(second.name)) return false
  const answer = answerOf(fn)
  if (answer === undefined) return false
  const body = unwrapExpression(answer)
  return (
    ts.isBinaryExpression(body) &&
    body.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    startRoot(body.left) === second.name.text &&
    startRoot(body.right) === first.name.text
  )
}

function descendingStartSorts(source: string, fileName = 'fixture.ts'): number {
  const file = parseSource(fileName, source)
  let count = 0
  const visit = (node: ts.Node): void => {
    if (isDescendingStartSort(node)) count += 1
    ts.forEachChild(node, visit)
  }
  visit(file)
  return count
}

/** Sorts in a file, read off the syntax tree only when the text could hold one. */
function sortsIn(path: string): number {
  const source = readFileSync(path, 'utf8')
  if (!source.includes('.start')) return 0
  return descendingStartSorts(source, path)
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
