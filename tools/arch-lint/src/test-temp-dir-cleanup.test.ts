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
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
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
const MAKES = /\bmkdtemp(Sync)?\(/
const REMOVES = /\b(rm|rmSync|rmdir|rmdirSync)\(/

/** Repo-relative test file -> why it makes a temp directory and never removes one itself. */
const LEDGER: Readonly<Record<string, string>> = {}

const REASON = /^(\S+\s+){7,}\S+/

/** Whether a test file's code makes a temp directory and has no removal at all. */
function leaks(fileName: string, raw: string): boolean {
  // The raw prefilter keeps the parse to the few hundred files that could match.
  if (!MAKES.test(raw)) return false
  const code = stripComments(raw, fileName)
  return MAKES.test(code) && !REMOVES.test(code)
}

function makes(fileName: string, raw: string): boolean {
  return MAKES.test(raw) && MAKES.test(stripComments(raw, fileName))
}

const files = ROOTS.flatMap((root) =>
  walk(join(REPO_ROOT, root), {
    include: (path) => TEST_FILE.test(path),
    skip: (_path, name) => SKIP_DIRS.has(name),
  }),
).map((absolute) => ({
  path: relative(REPO_ROOT, absolute).split(sep).join('/'),
  raw: readFileSync(absolute, 'utf8'),
}))
const making = files.filter(({ path, raw }) => makes(path, raw)).map(({ path }) => path)
const leaking = files.filter(({ path, raw }) => leaks(path, raw)).map(({ path }) => path)

describe('a test file that makes a temp directory removes one', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the counts are what keep it honest.
    expect(files.length).toBeGreaterThan(1500)
    expect(making.length).toBeGreaterThan(250)
    expect(making.some((path) => path.startsWith('.claude/scripts/'))).toBe(true)
    expect(making.some((path) => path.startsWith('packages/mcp-server/'))).toBe(true)
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
  })
})
