/**
 * Production source does not import a package's `test-utils`.
 *
 * A `test-utils` entry is where a package keeps doubles and conformance suites,
 * and its barrel re-exports modules that import `vitest`. A production file
 * that reaches one ships the double into the build — the daemon's container
 * once defaulted to the in-memory document store through exactly this import,
 * and `class InMemoryDocumentStore` sat in the built bundle — and nothing
 * fails, because the double behaves.
 *
 * Out of scope by construction, not by allowlist: tests, benches, a
 * `test-utils/` directory and a `_test-*` helper AS THE IMPORTER. Whatever else
 * a package keeps for tests only, under a name that says neither, is listed
 * below with why, and the entry is checked from both sides.
 *
 * A helper named `<thing>-test-utils` counts as a test-utils module for the
 * importee side, and Testing Library counts as a test framework.
 *
 * Two more ways a double ships. A production file importing a `_test-*` helper
 * pulls that helper (and the `vitest` it imports) into the build, since the
 * name exempts the helper as an importer and nothing checked it as the
 * importee. And mcp-server and apps/web are composition roots, so the boundary
 * scan never reads them: `vitest` or `fast-check` imported by a production file
 * there is read here instead.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { collectModuleSpecifiers, scanSourceForBoundaryViolations } from './scanner.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

/**
 * An import or re-export specifier whose path has a `test-utils` segment, or
 * whose basename ends in `-test-utils` (`node-editor-test-utils.js`).
 */
const TEST_UTILS_SPECIFIER =
  /(?:from|import\s*\(?)\s*['"]([^'"]*(?:^|[/@-])test-utils(?:\/[^'"]*|\.[cm]?[jt]sx?)?)['"]/g

const ALLOWLIST: Readonly<Record<string, string>> = {
  'apps/web/src/docs-snapshots/_helpers.ts':
    'support for the doc-screenshot vitest browser tests: the directory holds only those tests and what they share, and nothing outside it imports it, so it is test scaffolding under a name that says neither',
  'packages/facet-engine/src/testing/facet-arbitraries.ts':
    'fast-check arbitraries a plugin author imports from facet-engine/testing to test their own facets, built over model/test-utils; the testing entry is itself test-only and not reachable from the package root',
}

/**
 * Production files in the composition roots that import a test framework, with
 * why. None is imported by shipped code today; the entry is checked from both
 * sides, so it cannot outlive that.
 */
const TEST_FRAMEWORK_ALLOWLIST: Readonly<Record<string, string>> = {
  'apps/web/src/docs-snapshots/_helpers.ts':
    'shared support of the doc-screenshot vitest browser tests (`vitest/browser` locators and `@testing-library/react` `waitFor`): the directory holds only those tests and what they share, and nothing outside it imports it',
  'apps/web/src/components/spatial-editor/node-editor-test-utils.ts':
    'the CodeMirror node editor helpers (`@testing-library/react` `fireEvent`) that browser tests share: its name ends in test-utils but sits in a shipped directory, and only test files import it',
  'apps/web/src/docs-snapshots/_setup.ts':
    'the vitest setup file of the doc-screenshot browser tests: only that project loads it, and nothing outside docs-snapshots imports it',
}

/** Roots whose production source the boundary scan never reads. */
const COMPOSITION_ROOT_SRC = ['packages/mcp-server/src', 'apps/web/src']

function isProductionFile(path: string): boolean {
  const rel = relativeToRepo(path)
  return (
    !isTestPath(path) &&
    !/\.bench\.tsx?$/.test(rel) &&
    !/(?:^|\/)_test-[^/]*$/.test(rel) &&
    !isExcludedPath(path)
  )
}

function testUtilsImports(source: string): string[] {
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
  return [...code.matchAll(TEST_UTILS_SPECIFIER)].map((match) => match[1] ?? '')
}

/** Relative specifiers whose basename is a `_test-*` helper, other than a type-only (erased) edge. */
function testHelperImports(path: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return collectModuleSpecifiers(sourceFile)
    .filter(({ specifier, typeOnly }) => !typeOnly && /(?:^|\/)_test-[^/]*$/.test(specifier))
    .map(({ specifier }) => specifier)
}

function testFrameworkImports(path: string, source: string): string[] {
  return scanSourceForBoundaryViolations(path, source)
    .filter(({ kind }) => kind === 'test-framework-import')
    .map(({ name }) => name)
}

const all = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root)))
const production = all.filter(isProductionFile)

describe('production source does not import test-utils', () => {
  it('recognises package, subpath and relative specifiers, and passes prose and look-alikes through', () => {
    expect(testUtilsImports("import { x } from '@kamiazya/whiteboard-ports/test-utils'")).toEqual([
      '@kamiazya/whiteboard-ports/test-utils',
    ])
    expect(testUtilsImports("import { x } from '../shared/test-utils/fast-check.js'")).toEqual([
      '../shared/test-utils/fast-check.js',
    ])
    expect(testUtilsImports("export * from './test-utils/index.js'")).toEqual([
      './test-utils/index.js',
    ])
    // Joined, so this fixture is not itself a literal dynamic import in a test file.
    const dynamic = ['const m = await ', "import('@x/test-utils')"].join('')
    expect(testUtilsImports(dynamic)).toEqual(['@x/test-utils'])
    expect(testUtilsImports("// import { x } from '@x/test-utils'")).toEqual([])
    // A helper whose BASENAME only ends in `-test-utils` is a test-utils module too.
    expect(testUtilsImports("import { x } from './node-editor-test-utils.js'")).toEqual([
      './node-editor-test-utils.js',
    ])
    expect(testUtilsImports("export * from '../a/node-editor-test-utils'")).toEqual([
      '../a/node-editor-test-utils',
    ])
    expect(testUtilsImports("import { x } from './not-test-utilsy.js'")).toEqual([])
    expect(testUtilsImports("import { x } from './test-utils-not.js'")).toEqual([])
  })

  it('recognises a `_test-*` helper by the specifier basename, and not a type-only edge or a look-alike', () => {
    const helpers = (source: string): string[] => testHelperImports('x.ts', source)
    expect(helpers("import { w } from './_test-helpers.js'")).toEqual(['./_test-helpers.js'])
    expect(helpers("export * from '../routes/_test-route-fuzz-lane.js'")).toEqual([
      '../routes/_test-route-fuzz-lane.js',
    ])
    const dynamic = ['const m = await ', "import('./_test-helpers.js')"].join('')
    expect(helpers(dynamic)).toEqual(['./_test-helpers.js'])
    expect(helpers("import type { W } from './_test-helpers.js'")).toEqual([])
    expect(helpers("import { x } from './not_test-helpers.js'")).toEqual([])
    expect(helpers("// import { w } from './_test-helpers.js'")).toEqual([])
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(all.length).toBeGreaterThan(1500)
    expect(production.length).toBeGreaterThan(800)
    expect(production.length).toBeLessThan(all.length)
  })

  it('no production file imports one', () => {
    const hits: string[] = []
    for (const path of production) {
      const rel = relativeToRepo(path)
      if (rel in ALLOWLIST) continue
      const found = testUtilsImports(readFileSync(path, 'utf8'))
      if (found.length > 0) hits.push(`${rel}: ${found.join(', ')}`)
    }
    expect(hits).toEqual([])
  })

  it('no production file imports a `_test-*` helper', () => {
    const hits = production.flatMap((path) => {
      const found = testHelperImports(path, readFileSync(path, 'utf8'))
      return found.length > 0 ? [`${relativeToRepo(path)}: ${found.join(', ')}`] : []
    })
    expect(hits).toEqual([])
  })

  describe('a composition root does not import a test framework from production source', () => {
    const roots = production.filter((path) =>
      COMPOSITION_ROOT_SRC.some((root) => relativeToRepo(path).startsWith(`${root}/`)),
    )
    const importing = (path: string): string[] =>
      testFrameworkImports(path, readFileSync(path, 'utf8'))

    it('recognises vitest and fast-check specifiers', () => {
      expect(testFrameworkImports('x.ts', "import { it } from 'vitest'")).toEqual(['vitest'])
      expect(testFrameworkImports('x.ts', "import fc from 'fast-check'")).toEqual(['fast-check'])
      expect(testFrameworkImports('x.ts', "import { a } from './vitest-like.js'")).toEqual([])
    })

    it('reads the roots worth reading', () => {
      expect(roots.length).toBeGreaterThan(500)
    })

    it('reports no production file outside the ledger', () => {
      const hits = roots
        .filter((path) => !(relativeToRepo(path) in TEST_FRAMEWORK_ALLOWLIST))
        .flatMap((path) => {
          const found = importing(path)
          return found.length > 0 ? [`${relativeToRepo(path)}: ${found.join(', ')}`] : []
        })
      expect(hits).toEqual([])
    })

    it('keeps every ledgered file production source that still imports one', () => {
      for (const [rel, reason] of Object.entries(TEST_FRAMEWORK_ALLOWLIST)) {
        expect(isProductionFile(join(REPO_ROOT, rel)), `${rel} is not production source`).toBe(true)
        expect(importing(join(REPO_ROOT, rel)), rel).not.toEqual([])
        expect(reason.split(/\s+/).length, `${rel}'s reason is too short`).toBeGreaterThan(8)
      }
    })
  })

  it('every allowlisted file is production source and still imports one', () => {
    // Guarded from both sides: an entry that stopped being true exempts nothing
    // and reads exactly like a rule being kept.
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      const path = join(REPO_ROOT, rel)
      expect(isProductionFile(path), `${rel} is not production source`).toBe(true)
      expect(testUtilsImports(readFileSync(path, 'utf8')), rel).not.toEqual([])
      expect(reason.split(/\s+/).length, `${rel}'s reason is too short to be one`).toBeGreaterThan(
        8,
      )
    }
  })
})
