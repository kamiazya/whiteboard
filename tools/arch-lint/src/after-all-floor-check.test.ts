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
 * Read structurally: a call to `expect`, `expect.*`, `assert` (node:assert's,
 * `assert.ok` and the rest included) or an `assert*` helper, or a `throw`,
 * anywhere inside the hook's callback — inline, or a function passed by name
 * that this file declares or imports from a relative path. `afterAll` is
 * recognised under whatever local name vitest's import binds it to. A cleanup
 * hook (`rm`, `dispose`, `close`) asserts nothing and is left alone.
 *
 * Blind spots, each a shape no test in the repo uses: a helper imported from a
 * package specifier rather than a relative path, and an assertion one call
 * deeper than the function the hook is handed.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
  return (
    ts.isIdentifier(callee) && (callee.text === 'expect' || /^assert(?:[A-Z]|$)/.test(callee.text))
  )
}

const asserts = (root: ts.Node): boolean => {
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (isAssertionCall(node) || ts.isThrowStatement(node)) found = true
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

/** The local names vitest's `afterAll` is imported under: `afterAll`, or its alias. */
function afterAllNames(source: ts.SourceFile): Set<string> {
  const names = new Set(['afterAll'])
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== 'vitest') continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'afterAll') names.add(element.name.text)
    }
  }
  return names
}

/** The relative module a name is imported from in this file, and the name it is exported as. */
function relativeImportOf(
  source: ts.SourceFile,
  name: string,
): { readonly specifier: string; readonly exported: string } | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (!specifier.startsWith('.')) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    const element = bindings.elements.find((one) => one.name.text === name)
    if (element) return { specifier, exported: (element.propertyName ?? element.name).text }
  }
  return undefined
}

/** Reads the module a relative specifier names, or `undefined` when there is none to read. */
type ImportReader = (
  fromFile: string,
  specifier: string,
) => { readonly fileName: string; readonly text: string } | undefined

const readRelativeImport: ImportReader = (fromFile, specifier) => {
  const base = resolve(REPO_ROOT, dirname(fromFile), specifier).replace(/\.[cm]?js$/, '')
  for (const candidate of ['.ts', '.tsx', '/index.ts', '.mjs', '.js', '']) {
    const full = `${base}${candidate}`
    if (statSync(full, { throwIfNoEntry: false })?.isFile()) {
      return { fileName: full, text: readFileSync(full, 'utf8') }
    }
  }
  return undefined
}

interface Scan {
  readonly unguarded: readonly number[]
  readonly floors: number
  readonly bareHooks: number
}

/** The function a hook was handed by name: declared here, or imported from a relative module. */
function namedCallback(
  source: ts.SourceFile,
  fileName: string,
  name: string,
  readImport: ImportReader,
): ts.Node | undefined {
  const local = declarationNamed(source, name)
  if (local) return local
  const imported = relativeImportOf(source, name)
  if (!imported) return undefined
  const module = readImport(fileName, imported.specifier)
  if (!module) return undefined
  return declarationNamed(parseSource(module.fileName, module.text, true), imported.exported)
}

function scan(fileName: string, text: string, readImport: ImportReader = readRelativeImport): Scan {
  const source = parseSource(fileName, text, true)
  const hookNames = afterAllNames(source)
  const unguarded: number[] = []
  let floors = 0
  let bareHooks = 0
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'afterAllFloor') floors += 1
      if (hookNames.has(node.expression.text)) {
        bareHooks += 1
        const [callback] = node.arguments
        const body =
          callback && ts.isIdentifier(callback)
            ? namedCallback(source, fileName, callback.text, readImport)
            : callback
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
  })

  it('reads the variant spellings of an assertion and of the hook (self-test)', () => {
    expect(
      scan('x.test.ts', "afterAll(() => {\n  if (drawn < 1) throw new Error('unmet')\n})")
        .unguarded,
    ).toEqual([1])
    expect(scan('x.test.ts', 'afterAll(() => {\n  assert(drawn > 0)\n})').unguarded).toEqual([1])
    expect(scan('x.test.ts', 'afterAll(() => {\n  assert.ok(drawn > 0)\n})').unguarded).toEqual([1])
    expect(
      scan(
        'x.test.ts',
        "import { afterAll as after } from 'vitest'\nafter(() => expect(drawn).toBe(1))",
      ).unguarded,
    ).toEqual([2])
    // A cleanup helper of that name stays a cleanup: `assertions` is not `assert`.
    expect(scan('x.test.ts', 'afterAll(() => assertions.clear())').unguarded).toEqual([])
    const helpers: Record<string, string> = {
      './floors.js': 'export function checkFloors() { expect(drawn).toBe(1) }',
      './cleanup.js': 'export async function clearDb() { await rm(dir) }',
    }
    const readHelper = (_from: string, specifier: string) => {
      const text = helpers[specifier]
      return text === undefined ? undefined : { fileName: specifier, text }
    }
    expect(
      scan(
        'x.test.ts',
        "import { checkFloors } from './floors.js'\nafterAll(checkFloors)",
        readHelper,
      ).unguarded,
    ).toEqual([2])
    expect(
      scan(
        'x.test.ts',
        "import { checkFloors as floors } from './floors.js'\nafterAll(floors)",
        readHelper,
      ).unguarded,
    ).toEqual([2])
    expect(
      scan('x.test.ts', "import { clearDb } from './cleanup.js'\nafterAll(clearDb)", readHelper)
        .unguarded,
    ).toEqual([])
    // The real reader, against a real helper: `.js` names the `.ts` beside it.
    expect(
      scan(
        'apps/web/src/x.test.ts',
        "import { assertLedger } from './test-utils/coverage-ledger.js'\nafterAll(assertLedger)",
      ).unguarded,
    ).toEqual([2])
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
