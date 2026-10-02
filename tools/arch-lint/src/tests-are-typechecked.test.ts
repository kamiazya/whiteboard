import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from '@typescript/typescript6'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { listTestFiles, TEST_SCAN_DIRS } from './test-scan-dirs.js'

// `pnpm -r typecheck` (pre-push, CI's `check` job) is the only gate that reads
// types, and vitest strips them. A package whose tsconfig leaves its test
// files out is therefore not type-checked there at all: a test that no longer
// compiles against a changed production type passes locally and fails at
// runtime with a message about the symptom, not the signature.
// `mcp-server` was exactly that — its build config excludes `*.test.ts` so
// they stay out of `dist` — until `tsconfig.test.json` was added to its
// `typecheck` script.

/** Which tsconfig names a script mentions, following the scripts it runs. */
function reachableConfigNames(scripts: Readonly<Record<string, string>>): string[] | null {
  if (scripts.typecheck === undefined) return null
  const seen = new Set<string>()
  const texts: string[] = []
  const visit = (name: string): void => {
    const text = scripts[name]
    if (text === undefined || seen.has(name)) return
    seen.add(name)
    texts.push(text)
    for (const m of text.matchAll(/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?([a-z][\w:-]*)/g)) {
      visit(m[1] ?? '')
    }
  }
  visit('typecheck')
  const named = texts.flatMap((text) => text.match(/[\w./-]*tsconfig[\w.-]*\.json/g) ?? [])
  // `tsc` with no `-p` reads the package's own `tsconfig.json`.
  return named.length > 0 ? [...new Set(named)] : ['tsconfig.json']
}

/** The files tsc itself would compile for `configPath`, `extends` and `exclude` resolved. */
function compiledFiles(configPath: string): string[] {
  if (!existsSync(configPath)) return []
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  )
  return parsed.fileNames.map((file) => resolve(file))
}

/** Test files under `packageDir` that no tsconfig its `typecheck` script runs compiles. */
function untypecheckedTests(packageDir: string): string[] {
  const scripts = (
    JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
  ).scripts
  const configs = reachableConfigNames(scripts ?? {})
  const compiled = new Set(
    (configs ?? []).flatMap((name) => compiledFiles(resolve(packageDir, name))),
  )
  return listTestFiles(packageDir)
    .filter((file) => !compiled.has(resolve(file)))
    .map((file) => relative(packageDir, file))
    .sort()
}

describe('untypecheckedTests', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  function fixture(files: Record<string, string>): string {
    dir = mkdtempSync(join(tmpdir(), 'tests-typechecked-'))
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    return dir
  }

  const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'p', scripts })
  const sources = { 'src/a.ts': 'export {}', 'src/a.test.ts': 'export {}' }

  it('finds nothing when the config the script runs includes the test files', () => {
    const root = fixture({
      ...sources,
      'package.json': pkg({ typecheck: 'tsc --noEmit' }),
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
    })
    expect(untypecheckedTests(root)).toEqual([])
  })

  it('names the test files a config excludes, including one inherited through extends', () => {
    const root = fixture({
      ...sources,
      'package.json': pkg({ typecheck: 'tsc -p tsconfig.server.json --noEmit' }),
      'tsconfig.base.json': JSON.stringify({ exclude: ['src/**/*.test.ts'] }),
      'tsconfig.server.json': JSON.stringify({ extends: './tsconfig.base.json', include: ['src'] }),
    })
    expect(untypecheckedTests(root)).toEqual(['src/a.test.ts'])
  })

  it('follows a script the typecheck script runs to the config that does include them', () => {
    const root = fixture({
      ...sources,
      'package.json': pkg({
        typecheck: 'tsc -p tsconfig.server.json --noEmit && pnpm run typecheck:tests',
        'typecheck:tests': 'node check.mjs tsconfig.test.json',
      }),
      'tsconfig.server.json': JSON.stringify({ include: ['src'], exclude: ['src/**/*.test.ts'] }),
      'tsconfig.test.json': JSON.stringify({ include: ['src'], exclude: [] }),
    })
    expect(untypecheckedTests(root)).toEqual([])
  })

  it('does not count a config the typecheck script never reaches', () => {
    const root = fixture({
      ...sources,
      'package.json': pkg({ typecheck: 'tsc -p tsconfig.server.json --noEmit' }),
      'tsconfig.server.json': JSON.stringify({ include: ['src'], exclude: ['src/**/*.test.ts'] }),
      'tsconfig.test.json': JSON.stringify({ include: ['src'] }),
    })
    expect(untypecheckedTests(root)).toEqual(['src/a.test.ts'])
  })

  it('names every test file when the package has no typecheck script', () => {
    const root = fixture({
      ...sources,
      'package.json': pkg({ test: 'vitest' }),
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
    })
    expect(untypecheckedTests(root)).toEqual(['src/a.test.ts'])
  })
})

/**
 * Packages whose tests are only partly type-checked, with how many files and
 * why. Guarded from both sides below, and shrink-only: a package cannot be
 * added without changing the pinned size, and an entry whose count no longer
 * matches fails until it is lowered or dropped.
 */
const PARTLY_UNCHECKED: Readonly<
  Record<string, { readonly files: number; readonly reason: string }>
> = {
  'apps/web': {
    files: 16,
    reason:
      'tsconfig.json includes src/ and the two vite configs; the root-level *.test.ts and ' +
      'scripts/*.test.ts beside them are outside it. Including them surfaces 9 errors: four ' +
      'untyped scripts/*.mjs imports (needs allowJs), two Uint8Array<ArrayBufferLike> ' +
      'arguments to BufferSource, two possibly-undefined manifests.',
  },
}
const PARTLY_UNCHECKED_PACKAGES_PINNED = 1

/**
 * mcp-server's test typecheck tolerates the error codes recorded per file in
 * its ledger (scripts/typecheck-tests.mjs fails on any error outside it, a swap
 * of one for another, and a file that carries fewer than recorded), and this
 * pins its size from outside, so
 * a file cannot be added to it without this number being raised in review.
 */
const MCP_TEST_TYPE_DEBT = { files: 2, errors: 4 }

describe('every package type-checks its test files', () => {
  const dirs = TEST_SCAN_DIRS

  it('finds the packages and test files it is meant to judge', () => {
    expect(dirs.length, 'the workspace walk found almost nothing').toBeGreaterThan(15)
    const tests = dirs.reduce((n, dir) => n + listTestFiles(join(REPO_ROOT, dir)).length, 0)
    expect(tests, 'the test-file walk found almost nothing').toBeGreaterThan(1000)
  })

  it('compiles every test file in each package, apart from the recorded exceptions', () => {
    const offenders = dirs
      .map((dir) => ({ dir, missed: untypecheckedTests(join(REPO_ROOT, dir)) }))
      .filter(({ dir, missed }) => missed.length > 0 && PARTLY_UNCHECKED[dir] === undefined)
      .map(({ dir, missed }) => `${dir}: ${missed.length} (e.g. ${missed[0]})`)
    expect(
      offenders,
      'these packages leave test files out of every tsconfig their `typecheck` script runs, so a ' +
        'type error in a test passes `pnpm -r typecheck` and surfaces only when the test runs. ' +
        'Add the files to a config the script runs (a tsconfig.test.json, as mcp-server has).',
    ).toEqual([])
  })

  it('keeps every recorded exception a real package that still leaves exactly that many out', () => {
    const stale = Object.entries(PARTLY_UNCHECKED).flatMap(([dir, entry]) => {
      if (!dirs.includes(dir)) return [`${dir}: not a workspace package`]
      const missed = untypecheckedTests(join(REPO_ROOT, dir)).length
      if (missed !== entry.files) return [`${dir}: ${missed} left out, ledger says ${entry.files}`]
      return entry.reason.trim().length > 40 ? [] : [`${dir}: give the reason some substance`]
    })
    expect(stale, 'lower or drop the entry; the ledger only shrinks').toEqual([])
  })

  it('pins how many packages are exceptions', () => {
    expect(Object.keys(PARTLY_UNCHECKED).length).toBe(PARTLY_UNCHECKED_PACKAGES_PINNED)
  })
})

describe('mcp-server test typecheck ledger', () => {
  const ledgerPath = join(REPO_ROOT, 'packages/mcp-server/scripts/typecheck-tests-debt.json')
  const files = (
    JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { files: Record<string, readonly string[]> }
  ).files

  it('is the size this file pins, so the debt cannot grow unseen', () => {
    expect(Object.keys(files).length, 'files in the ledger').toBe(MCP_TEST_TYPE_DEBT.files)
    expect(
      Object.values(files).reduce((total, codes) => total + codes.length, 0),
      'errors in the ledger',
    ).toBe(MCP_TEST_TYPE_DEBT.errors)
  })

  it('names only files that exist', () => {
    const gone = Object.keys(files).filter(
      (file) => !existsSync(join(REPO_ROOT, 'packages/mcp-server', file)),
    )
    expect(gone, 'a deleted file is paid-down debt: run typecheck:tests:ratchet').toEqual([])
  })
})
