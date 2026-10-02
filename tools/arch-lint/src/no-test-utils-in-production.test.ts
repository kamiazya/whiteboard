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
 * `test-utils/` directory and a `_test-*` helper. Whatever else a package
 * keeps for tests only, under a name that says neither, is listed below with
 * why, and the entry is checked from both sides.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

/** An import or re-export specifier whose path has a `test-utils` segment. */
const TEST_UTILS_SPECIFIER =
  /(?:from|import\s*\(?)\s*['"]([^'"]*(?:^|[/@-])test-utils(?:\/[^'"]*)?)['"]/g

const ALLOWLIST: Readonly<Record<string, string>> = {
  'apps/web/src/docs-snapshots/_helpers.ts':
    'support for the doc-screenshot vitest browser tests: the directory holds only those tests and what they share, and nothing outside it imports it, so it is test scaffolding under a name that says neither',
  'packages/facet-engine/src/testing/facet-arbitraries.ts':
    'fast-check arbitraries a plugin author imports from facet-engine/testing to test their own facets, built over model/test-utils; the testing entry is itself test-only and not reachable from the package root',
}

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
    expect(testUtilsImports("import { x } from './not-test-utilsy.js'")).toEqual([])
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
