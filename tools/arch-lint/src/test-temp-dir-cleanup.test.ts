/**
 * A test file that makes a temp directory also removes one.
 *
 * Why it needs a scan. A leaked `mkdtemp` fails nothing: the run is green, and
 * the cost lands in every contributor's `/tmp`, one directory per test per
 * run, multiplied by every mutant a Stryker lane runs. Measured on one shared
 * machine: about 4,700 `/tmp/whiteboard-*` directories from five files, and a
 * further ninety per run of the thirty-one files that made a directory and had no
 * removal anywhere in them, until `du` over `/tmp` no longer finished.
 *
 * What it checks is deliberately coarse: a file whose code (comments
 * stripped) calls `mkdtemp(` or `mkdtempSync(` must also call one of the
 * removal functions. It cannot tell a removal that reaches every directory
 * from one that reaches some; it catches the shape that leaked, a file with
 * no removal at all. A file that hands its directory to a helper that removes
 * it, or keeps one on purpose, is ledgered with the reason, and the ledger is
 * guarded from both sides so an entry cannot outlive the file it excuses.
 *
 * Three refinements each close a shape that passed the coarse check while
 * leaking:
 * - shared helpers (`test-utils/**`, `_test-*`) are read too, since a helper
 *   that makes a directory per call leaks once per caller;
 * - a removal registered only on `process.on('exit')` does not count, because
 *   a vitest worker is torn down without emitting it;
 * - inside a test body, a directory bound to a local `const` must be removed
 *   in that body (a removal call or `onTestFinished`) or handed on (pushed to
 *   a tracker, assigned outward), since no hook can reach a test's local.
 *   That is the per-call-site half: a file whose other tests remove their own
 *   directory no longer excuses the one that does not.
 *
 * Still invisible: a directory built from `tmpdir()` without `mkdtemp` (the
 * code under test creates it), and a directory made in a hook or helper whose
 * removal reaches only some of what it made.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { isTypeOnlyWrapper, parseSource, unwrapExpression } from './ast-helpers.js'
import { REPO_ROOT, walk } from './scan-roots.js'
import { stripComments } from './strip-comments.js'

/** Every tree that holds a test file: the workspaces, the smokes, and the dev tooling. */
const ROOTS = [
  'apps',
  'packages',
  'tools',
  'tests',
  '.claude/scripts',
  '.claude/workflows',
] as const

/** Installed dependencies, build output, caches and scratch, none of which is this repo's test. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'tmp', '.vite', '.vitest'])

const TEST_FILE = /\.test\.(tsx?|mts|mjs|js)$/
/** Shared test scaffolding, which runs once per caller. */
const TEST_HELPER = /(\/test-utils\/.+|\/_test-[^/]+)\.(tsx?|mts|mjs|js)$/
const MAKES = /\bmkdtemp(Sync)?\(/
const REMOVES = /\b(rm|rmSync|rmdir|rmdirSync)\(/
const REMOVAL_CALLS = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync', 'onTestFinished'])
/** What a test body may hand its directory to so something else removes it. */
const HAND_ON_CALLS = new Set(['push', 'add', 'set'])

/** Repo-relative test file -> why it makes a temp directory and never removes one itself. */
const LEDGER: Readonly<Record<string, string>> = {}

const REASON = /^(\S+\s+){7,}\S+/

/** `process.on('exit', ...)` / `process.once('exit', ...)`: never emitted when vitest tears a worker down. */
function isExitHook(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const callee = unwrapExpression(node.expression)
  const [event] = node.arguments
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'process' &&
    (callee.name.text === 'on' || callee.name.text === 'once') &&
    event !== undefined &&
    ts.isStringLiteralLike(event) &&
    event.text === 'exit'
  )
}

/**
 * The code with every exit hook blanked out, so a removal inside one is not
 * read as a removal — and with the declaration of a callback an exit hook is
 * handed by name, which runs no sooner.
 */
function withoutExitHooks(code: string, fileName: string): string {
  const spans: Array<[number, number]> = []
  const exitCallbacks = new Set<string>()
  const source = parseSource(fileName, code)
  const findHooks = (node: ts.Node): void => {
    if (isExitHook(node)) {
      spans.push([node.getStart(), node.getEnd()])
      const callback = node.arguments[1]
      if (callback !== undefined && ts.isIdentifier(callback)) exitCallbacks.add(callback.text)
    } else node.forEachChild(findHooks)
  }
  findHooks(source)
  const findCallbacks = (node: ts.Node): void => {
    const named =
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      exitCallbacks.has(node.name.text)
    if (named) spans.push([node.getStart(), node.getEnd()])
    else node.forEachChild(findCallbacks)
  }
  if (exitCallbacks.size > 0) findCallbacks(source)
  spans.sort((a, b) => a[0] - b[0])
  let out = code
  for (const [start, end] of spans.reverse()) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end)
  }
  return out
}

/** Whether a file's code makes a temp directory and has no removal that runs. */
function leaks(fileName: string, raw: string): boolean {
  // The raw prefilter keeps the parse to the few hundred files that could match.
  if (!MAKES.test(raw)) return false
  const code = stripComments(raw, fileName)
  return MAKES.test(code) && !REMOVES.test(withoutExitHooks(code, fileName))
}

function calleeName(expression: ts.Expression): string | undefined {
  const callee = unwrapExpression(expression)
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return undefined
}

/** `it`, `test`, and their `.each(...)` / `.concurrent` / `.skip` forms. */
function isTestCall(call: ts.CallExpression): boolean {
  let callee: ts.Expression = unwrapExpression(call.expression)
  while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) {
    callee = unwrapExpression(callee.expression)
  }
  return ts.isIdentifier(callee) && (callee.text === 'it' || callee.text === 'test')
}

/** The test body a `mkdtemp` call is made in directly, not through a nested function. */
function enclosingTestBody(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) {
      return ts.isCallExpression(at.parent) && isTestCall(at.parent) ? at : undefined
    }
    if (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) return undefined
  }
  return undefined
}

/** The `const` a call's result is bound to, through `await` and type-only wrappers. */
function boundName(call: ts.CallExpression): string | undefined {
  let at: ts.Node = call.parent
  while (ts.isAwaitExpression(at) || isTypeOnlyWrapper(at)) at = at.parent
  return ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) ? at.name.text : undefined
}

/** Whether `node` reads the identifier `name` anywhere inside it. */
function mentions(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true
  return node.forEachChild((child) => mentions(child, name) || undefined) ?? false
}

/** Whether a test body removes `name` itself, or hands it to something that will. */
function bodyAccountsFor(body: ts.Node, name: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression) ?? ''
      if (REMOVAL_CALLS.has(callee) && node.arguments.some((arg) => mentions(arg, name))) {
        found = true
      }
      if (
        HAND_ON_CALLS.has(callee) &&
        node.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === name)
      ) {
        found = true
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.right) &&
      node.right.text === name
    ) {
      found = true
    }
    node.forEachChild(visit)
  }
  visit(body)
  return found
}

/** 1-based lines of the `mkdtemp` calls a test body binds to a local and then loses. */
function leakingCallSites(fileName: string, raw: string): number[] {
  if (!MAKES.test(raw)) return []
  const source = parseSource(fileName, raw)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && /^mkdtemp(Sync)?$/.test(calleeName(node.expression) ?? '')) {
      const body = enclosingTestBody(node)
      const name = boundName(node)
      if (body !== undefined && name !== undefined && !bodyAccountsFor(body, name)) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return lines
}

function makes(fileName: string, raw: string): boolean {
  return MAKES.test(raw) && MAKES.test(stripComments(raw, fileName))
}

const files = ROOTS.flatMap((root) =>
  walk(join(REPO_ROOT, root), {
    include: (path) => TEST_FILE.test(path) || TEST_HELPER.test(path.split(sep).join('/')),
    skip: (_path, name) => SKIP_DIRS.has(name),
  }),
).map((absolute) => ({
  path: relative(REPO_ROOT, absolute).split(sep).join('/'),
  raw: readFileSync(absolute, 'utf8'),
}))
const making = files.filter(({ path, raw }) => makes(path, raw)).map(({ path }) => path)
const leaking = files.filter(({ path, raw }) => leaks(path, raw)).map(({ path }) => path)
const leakingSites = files.flatMap(({ path, raw }) =>
  leakingCallSites(path, raw).map((line) => `${path}:${line}`),
)

describe('a test file that makes a temp directory removes one', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the counts are what keep it honest.
    expect(files.length).toBeGreaterThan(1500)
    expect(making.length).toBeGreaterThan(250)
    expect(making.some((path) => path.startsWith('.claude/scripts/'))).toBe(true)
    expect(making.some((path) => path.startsWith('packages/mcp-server/'))).toBe(true)
    expect(making.some((path) => TEST_HELPER.test(path))).toBe(true)
  })

  it('every directory a test body binds to a local is removed or handed on in that body', () => {
    expect(
      leakingSites,
      'no hook can reach a test-local directory: remove it in the test (`onTestFinished(() => rm(dir, { recursive: true, force: true }))`) or push it to a tracker a hook removes',
    ).toEqual([])
  })

  it('every file that makes one removes one, or is ledgered', () => {
    const unledgered = leaking.filter((path) => LEDGER[path] === undefined)
    expect(
      unledgered,
      'remove what the file made: `afterEach`/`afterAll` with `rm(dir, { recursive: true, force: true })` (or `after` under node:test), or make the directory through `withTempDataDir` (mcp-server routes test helpers), which removes it',
    ).toEqual([])
  })

  it('every ledger entry still names a file that makes one and removes none', () => {
    const stale = Object.keys(LEDGER).filter((path) => !leaking.includes(path))
    expect(stale, 'an entry that outlives its leak is how a ledger stops being read').toEqual([])
  })

  it('every ledger entry gives a reason of at least eight words', () => {
    const bare = Object.entries(LEDGER)
      .filter(([, why]) => !REASON.test(why))
      .map(([path]) => path)
    expect(bare).toEqual([])
  })

  describe('the scan itself, on planted source', () => {
    it('flags a file that makes a directory and never removes it', () => {
      const planted = [
        "import { mkdtempSync } from 'node:fs'",
        "const dir = mkdtempSync('/tmp/x-')",
        "it('uses it', () => expect(dir).toBeTruthy())",
      ].join('\n')
      expect(leaks('planted.test.ts', planted)).toBe(true)
    })

    it('passes the same file once it removes the directory', () => {
      const planted = [
        "import { mkdtempSync, rmSync } from 'node:fs'",
        "const dir = mkdtempSync('/tmp/x-')",
        'afterAll(() => rmSync(dir, { recursive: true, force: true }))',
      ].join('\n')
      expect(leaks('planted.test.ts', planted)).toBe(false)
    })

    it('is not satisfied by a removal that is only named in a comment', () => {
      const planted = [
        "const dir = await fs.mkdtemp('/tmp/x-')",
        '// rm(dir) happens elsewhere',
      ].join('\n')
      expect(leaks('planted.test.ts', planted)).toBe(true)
    })

    it('ignores a file that only names mkdtemp in a comment', () => {
      expect(leaks('planted.test.ts', '// mkdtemp(prefix) is not used here\nexport {}')).toBe(false)
    })

    it('does not count a removal registered only on process exit', () => {
      const planted = [
        "const dir = mkdtempSync('/tmp/x-')",
        "process.once('exit', () => rmSync(dir, { recursive: true, force: true }))",
      ].join('\n')
      expect(leaks('planted.test.ts', planted)).toBe(true)
      expect(leaks('planted.test.ts', planted.replace("process.once('exit',", 'afterAll('))).toBe(
        false,
      )
    })

    it('flags the test that loses its directory although a sibling test removes its own', () => {
      const planted = [
        "it('loses it', async () => {",
        "  const dir = await mkdtemp('/tmp/x-')",
        '  expect(dir).toBeTruthy()',
        '})',
        "it('removes it', async () => {",
        "  const dir = await mkdtemp('/tmp/x-')",
        '  onTestFinished(() => rm(dir, { recursive: true, force: true }))',
        '})',
      ].join('\n')
      expect(leaks('planted.test.ts', planted)).toBe(false)
      expect(leakingCallSites('planted.test.ts', planted)).toEqual([2])
    })

    it("does not count one directory's removal for another the same test makes", () => {
      const planted = [
        "it('makes two', async () => {",
        "  const first = await mkdtemp('/tmp/x-')",
        "  const second = await mkdtemp('/tmp/y-')",
        '  onTestFinished(() => rm(first, { recursive: true, force: true }))',
        '})',
      ].join('\n')
      expect(leakingCallSites('planted.test.ts', planted)).toEqual([3])
    })

    it('does not count a removal in a named callback registered only on process exit', () => {
      const planted = [
        "const dir = mkdtempSync('/tmp/x-')",
        'const cleanup = () => rmSync(dir, { recursive: true, force: true })',
        "process.once('exit', cleanup)",
      ].join('\n')
      expect(leaks('planted.test.ts', planted)).toBe(true)
      expect(leaks('planted.test.ts', planted.replace("process.once('exit',", 'afterAll('))).toBe(
        false,
      )
    })

    it('reads a helper nested below test-utils', () => {
      expect(TEST_HELPER.test('packages/x/src/test-utils/nested/dirs.ts')).toBe(true)
      expect(TEST_HELPER.test('packages/x/src/test-utils/dirs.ts')).toBe(true)
      expect(TEST_HELPER.test('packages/x/src/routes/_test-helpers.ts')).toBe(true)
      expect(TEST_HELPER.test('packages/x/src/routes/dirs.ts')).toBe(false)
    })

    it('accepts a test-local directory handed to a tracker a hook removes', () => {
      const planted = [
        "it.each([1])('tracks %s', async () => {",
        "  const dir = await mkdtemp('/tmp/x-')",
        '  dirs.push(dir)',
        '})',
      ].join('\n')
      expect(leakingCallSites('planted.test.ts', planted)).toEqual([])
    })
  })
})
