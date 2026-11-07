/**
 * A sort comparator in canvas-render answers through `compareNumbers`, never
 * through a subtraction (ADR-0054 decision 11, QR-20a).
 *
 * Why it needs a scan. `(a, b) => a - b` answers NaN for a NaN key, and
 * `Array.prototype.sort` reads NaN as "equal to everything": no order, so
 * where that key lands is whatever the engine's sort algorithm did, and a port
 * sorting with another algorithm lands it elsewhere. `compareNumbers`
 * (`det-math.ts`) writes the NaN policy down and has the subtraction's sign
 * everywhere else, so nothing ordered moves when a site is converted; that is
 * also why only a rule about where a subtraction may appear can notice a new
 * one — every golden is green either way.
 *
 * Read from the syntax tree. A comparator is the function handed to `.sort` /
 * `.toSorted`, inline or by a name declared in the same file. What it ANSWERS
 * is its concise body or a `return`, through `||`, `??`, `?:` and
 * the wrappers `unwrapExpression` looks through; a subtraction there is the finding. A subtraction stored in a
 * local and returned later is not followed — a named blind spot, with no
 * instance today.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource, unwrapExpression } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration

function answers(wrapped: ts.Expression, out: ts.Expression[]): void {
  const expression = unwrapExpression(wrapped)
  if (ts.isConditionalExpression(expression)) {
    answers(expression.whenTrue, out)
    answers(expression.whenFalse, out)
    return
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    answers(expression.left, out)
    answers(expression.right, out)
    return
  }
  out.push(expression)
}

function answersOf(fn: Fn): ts.Expression[] {
  const out: ts.Expression[] = []
  if (fn.body === undefined) return out
  if (!ts.isBlock(fn.body)) {
    answers(fn.body, out)
    return out
  }
  const visit = (node: ts.Node): void => {
    if (node !== fn && (ts.isFunctionLike(node) || ts.isClassLike(node))) return
    if (ts.isReturnStatement(node) && node.expression !== undefined) answers(node.expression, out)
    ts.forEachChild(node, visit)
  }
  visit(fn.body)
  return out
}

/** Every subtraction a sort comparator in `source` answers with. */
function subtractionComparators(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const named = new Map<string, Fn>()
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) named.set(node.name.text, node)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      named.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, collect)
  }
  collect(file)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'sort' || node.expression.name.text === 'toSorted')
    ) {
      const argument = node.arguments[0]
      const fn =
        argument === undefined
          ? undefined
          : ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
            ? argument
            : ts.isIdentifier(argument)
              ? named.get(argument.text)
              : undefined
      for (const answer of fn === undefined ? [] : answersOf(fn)) {
        if (
          ts.isBinaryExpression(answer) &&
          answer.operatorToken.kind === ts.SyntaxKind.MinusToken
        ) {
          found.push(answer.getText(file))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const production = walkSourceFiles(join(REPO_ROOT, 'packages/canvas-render/src'))
  .filter((path) => !isTestPath(path) && !relOf(path).includes('/test-utils/'))
  .map(relOf)

describe('canvas-render sorts numbers through compareNumbers', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(100)
  })

  it('no comparator answers with a subtraction', () => {
    const hits = production.flatMap((rel) =>
      subtractionComparators(rel, readFileSync(join(REPO_ROOT, rel), 'utf8')).map(
        (text) => `${rel}: ${text}`,
      ),
    )
    expect(
      hits,
      'compare with compareNumbers from det-math.ts: a subtraction answers NaN for a NaN key, which a sort reads as equal to everything',
    ).toEqual([])
  })

  describe('the scan itself, on planted source', () => {
    it('finds an inline, a chained, a branched and a named comparator', () => {
      const planted = [
        'export const a = (xs: number[]) => xs.sort((p, q) => p - q)',
        'export const b = (xs: { k: number; i: number }[]) => xs.toSorted((p, q) => p.k - q.k || p.i - q.i)',
        'export const c = (xs: number[], up: boolean) => xs.sort((p, q) => { return up ? p - q : q - p })',
        'const byValue = (p: number, q: number) => p - q',
        'export const d = (xs: number[]) => xs.sort(byValue)',
      ].join('\n')
      expect(subtractionComparators('planted.ts', planted)).toEqual([
        'p - q',
        'p.k - q.k',
        'p.i - q.i',
        'p - q',
        'q - p',
        'p - q',
      ])
    })

    // The named blind spot, pinned so the header cannot quietly stop being
    // true: a subtraction stored in a local and returned later is not followed.
    it('does not follow a subtraction stored in a local', () => {
      const planted =
        'export const h = (xs: number[]) => xs.sort((p, q) => { const d = p - q; return d })'
      expect(subtractionComparators('planted.ts', planted)).toEqual([])
    })

    it('leaves a subtraction that is not the answer, and compareNumbers', () => {
      const planted = [
        'declare function compareNumbers(a: number, b: number): number',
        'export const e = (xs: number[]) => xs.sort((p, q) => compareNumbers(p - 1, q - 1))',
        'export const f = (xs: number[]) => xs.sort(compareNumbers)',
        'export const g = (n: number) => n - 1',
      ].join('\n')
      expect(subtractionComparators('planted.ts', planted)).toEqual([])
    })
  })
})
