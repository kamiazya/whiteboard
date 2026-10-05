/**
 * An assertion in a bare `afterAll` — a reachability floor, a ledger tally —
 * must go through `afterAllFloor` (`@kamiazya/whiteboard-model/test-utils`).
 *
 * A floor asserts what a whole run drew. Run one test by name (`-t`, an
 * editor's run-this-test button, a line filter, `.only`) and the tests that
 * fill its counters never ran, so a bare `afterAll` fails the file with a
 * message that names no filter: "the surrogate property proved nothing:
 * expected 0 to be greater than 20". Measured before this guard: ten files
 * failed that way when one of their tests was run alone. `afterAllFloor`
 * asserts only when the named feeders actually ran, so a full run still fails
 * an unmet floor exactly as before.
 *
 * Read structurally: a call to `expect`, `expect.*`, or an `assert*` helper
 * anywhere inside the hook's callback — inline, or a function declared in the
 * same file and passed by name. A cleanup hook (`rm`, `dispose`, `close`)
 * asserts nothing and is left alone.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { listTestFiles, listTestHelperFiles, TEST_SCAN_DIRS } from './test-scan-dirs.js'

/** This guard's own fixtures spell the shape it hunts. */
const EXEMPT_FILES = new Set(['tools/arch-lint/src/after-all-floor-check.test.ts'])

const isAssertionCall = (node: ts.Node): boolean => {
  if (!ts.isCallExpression(node)) return false
  let callee: ts.Expression = node.expression
  while (ts.isPropertyAccessExpression(callee)) callee = callee.expression
  return ts.isIdentifier(callee) && (callee.text === 'expect' || /^assert[A-Z]/.test(callee.text))
}

const asserts = (root: ts.Node): boolean => {
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (isAssertionCall(node)) found = true
    else ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

/** A hook passed a function by name: the declaration it names, when this file holds one. */
function declarationNamed(source: ts.SourceFile, name: string): ts.Node | undefined {
  let declaration: ts.Node | undefined
  const visit = (node: ts.Node) => {
    if (declaration) return
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node
    else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    )
      declaration = node.initializer
    else ts.forEachChild(node, visit)
  }
  visit(source)
  return declaration
}

interface Scan {
  readonly unguarded: readonly number[]
  readonly floors: number
  readonly bareHooks: number
}

function scan(fileName: string, text: string): Scan {
  const source = parseSource(fileName, text, true)
  const unguarded: number[] = []
  let floors = 0
  let bareHooks = 0
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'afterAllFloor') floors += 1
      if (node.expression.text === 'afterAll') {
        bareHooks += 1
        const [callback] = node.arguments
        const body =
          callback && ts.isIdentifier(callback) ? declarationNamed(source, callback.text) : callback
        if (body && asserts(body)) {
          unguarded.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { unguarded, floors, bareHooks }
}

const repoPath = (full: string) => relative(REPO_ROOT, full).split(sep).join('/')

const scanned = TEST_SCAN_DIRS.flatMap((dir) => [
  ...listTestFiles(join(REPO_ROOT, dir)),
  ...listTestHelperFiles(join(REPO_ROOT, dir)),
])
  .map((full) => ({ file: repoPath(full), text: readFileSync(full, 'utf8') }))
  .filter(({ file }) => !EXEMPT_FILES.has(file))
  .map(({ file, text }) => ({ file, ...scan(file, text) }))

describe('assertions in afterAll go through afterAllFloor', () => {
  it('tells a floor from a cleanup hook (self-test)', () => {
    expect(scan('x.test.ts', 'afterAll(() => expect(drawn).toBeGreaterThan(0))').unguarded).toEqual(
      [1],
    )
    expect(scan('x.test.ts', 'afterAll(() => {\n  assertLedger(a, b)\n})').unguarded).toEqual([1])
    expect(
      scan('x.test.ts', 'afterAll(() => {\n  expect.soft(drawn).toBe(1)\n})').unguarded,
    ).toEqual([1])
    expect(
      scan('x.test.ts', 'function floors() { expect(drawn).toBe(1) }\nafterAll(floors)').unguarded,
    ).toEqual([2])
    expect(
      scan('x.test.ts', 'const floors = () => expect(drawn).toBe(1)\nafterAll(floors)').unguarded,
    ).toEqual([2])
    expect(scan('x.test.ts', 'afterAll(async () => { await rm(dir) })').unguarded).toEqual([])
    expect(scan('x.test.ts', 'afterAll(cleanupImported)').unguarded).toEqual([])
    const guarded = scan('x.test.ts', "afterAllFloor(['feeds'], () => expect(drawn).toBe(1))")
    expect(guarded).toEqual({ unguarded: [], floors: 1, bareHooks: 0 })
  })

  it('scans a real population, floors and cleanup hooks alike', () => {
    expect(scanned.length).toBeGreaterThan(1000)
    // Present before clean: a scan that found no hook at all would pass below.
    expect(scanned.reduce((sum, file) => sum + file.bareHooks, 0)).toBeGreaterThan(40)
    expect(scanned.reduce((sum, file) => sum + file.floors, 0)).toBeGreaterThanOrEqual(28)
  })

  it('finds no assertion in a bare afterAll', () => {
    const offenders = scanned.flatMap(({ file, unguarded }) =>
      unguarded.map((line) => `${file}:${line}`),
    )
    expect(
      offenders,
      'a floor in a bare afterAll fails any run that filtered its feeders away (-t, run-this-test) — use afterAllFloor(feeders, floor) from @kamiazya/whiteboard-model/test-utils',
    ).toEqual([])
  })
})
