/**
 * Every class that implements a store port runs that port's conformance suite.
 *
 * `describeDocumentStoreConformance`, `describeDocumentIndexConformance` and
 * `describeBlobStoreConformance` are what make two keepers' stores readings of
 * ONE contract rather than two. All twelve production implementers run one
 * today, but nothing tied `implements <Port>` to a call: two of the twelve
 * (`SealedDocumentStore`, `WorkspaceRoutedDocumentStore`) were added after the
 * suites, each by someone remembering. A thirteenth that forgets reads exactly
 * like one that ran it, because every other test of a store is green without.
 *
 * So the population is DERIVED (every `implements` of a port under
 * `packages/*\/src` and `apps/*\/src`, tests included) and each member is
 * ledgered to the test file that runs the matching suite over it. Both sides
 * fail: an implementer with no entry, and an entry whose class is gone, whose
 * file no longer calls the suite, or that no longer constructs the class.
 *
 * Blind spot, named: this reads `implements` clauses. An object literal typed
 * as a port, or a class that satisfies one structurally without saying so, is
 * not a member.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo } from './scan-roots.js'
import { walkSourceFiles } from './source-scan.js'
import { TEST_SCAN_DIRS } from './test-scan-dirs.js'

type Port = 'DocumentStore' | 'DocumentIndex' | 'BlobStore'
const PORTS: readonly Port[] = ['DocumentStore', 'DocumentIndex', 'BlobStore']

interface Implementer {
  readonly cls: string
  readonly port: Port
  readonly source: string
}

interface LedgerEntry extends Implementer {
  /** The test file that runs `describe<Port>Conformance` over this class. */
  readonly test: string
}

interface Exemption {
  readonly cls: string
  readonly source: string
  readonly reason: string
}

const suiteName = (port: Port): string => `describe${port}Conformance`

const CONFORMANCE_LEDGER: readonly LedgerEntry[] = [
  {
    cls: 'IdbDocumentStore',
    port: 'DocumentStore',
    source: 'apps/web/src/lib/idb-document-store.ts',
    test: 'apps/web/src/lib/idb-document-store.browser.test.tsx',
  },
  {
    cls: 'SealedDocumentStore',
    port: 'DocumentStore',
    source: 'apps/web/src/lib/sealed-document-store.ts',
    test: 'apps/web/src/lib/sealed-document-store.browser.test.tsx',
  },
  {
    cls: 'LibsqlDocumentStore',
    port: 'DocumentStore',
    source: 'packages/mcp-server/src/server/store/libsql/libsql-document-store.ts',
    test: 'packages/mcp-server/src/server/store/libsql/libsql-document-store.test.ts',
  },
  {
    cls: 'WorkspaceRoutedDocumentStore',
    port: 'DocumentStore',
    source: 'packages/mcp-server/src/server/store/workspace-plane.ts',
    test: 'packages/mcp-server/src/server/store/workspace-plane.test.ts',
  },
  {
    cls: 'InMemoryDocumentStore',
    port: 'DocumentStore',
    source: 'packages/ports/src/test-utils/in-memory-document-store.ts',
    test: 'packages/ports/src/test-utils/in-memory-document-store.test.ts',
  },
  {
    cls: 'IdbDocumentIndex',
    port: 'DocumentIndex',
    source: 'apps/web/src/lib/idb-document-index.ts',
    test: 'apps/web/src/lib/idb-document-index.browser.test.tsx',
  },
  {
    cls: 'FoldingBrowserIndex',
    port: 'DocumentIndex',
    source: 'apps/web/src/lib/folding-browser-index.ts',
    test: 'apps/web/src/lib/folding-browser-index.conformance.browser.test.tsx',
  },
  {
    cls: 'LoroWorkspaceDocumentIndex',
    port: 'DocumentIndex',
    source: 'packages/workspace-index/src/loro-workspace-document-index.ts',
    test: 'packages/workspace-index/src/loro-workspace-document-index.test.ts',
  },
  {
    cls: 'InMemoryDocumentIndex',
    port: 'DocumentIndex',
    source: 'packages/ports/src/test-utils/in-memory-document-index.ts',
    test: 'packages/ports/src/test-utils/in-memory-document-index.test.ts',
  },
  {
    cls: 'IdbBlobStore',
    port: 'BlobStore',
    source: 'apps/web/src/lib/idb-blob-store.ts',
    test: 'apps/web/src/lib/idb-blob-store.browser.test.tsx',
  },
  {
    cls: 'FsBlobStore',
    port: 'BlobStore',
    source: 'packages/mcp-server/src/server/store/fs/fs-blob-store.ts',
    test: 'packages/mcp-server/src/server/store/fs/fs-blob-store.test.ts',
  },
  {
    cls: 'InMemoryBlobStore',
    port: 'BlobStore',
    source: 'packages/mcp-server/src/server/store/inmemory/in-memory-blob-store.ts',
    test: 'packages/mcp-server/src/server/store/inmemory/in-memory-blob-store.test.ts',
  },
]

/** An implementer that is not a keeper's store, so has no contract to conform to. */
const NOT_A_STORE: readonly Exemption[] = [
  {
    cls: 'FakeDocumentStore',
    source: 'packages/workspace-index/src/document-store-workspace-docs.test.ts',
    reason:
      'a test double declared inside the one test that drives it, with a hook to land a rival ' +
      'writer between two calls; it implements only the save/append/compact paths that test ' +
      'needs, so the full contract is not something it claims',
  },
]

const FLOOR_PRODUCTION_IMPLEMENTERS = 12

function portsImplementedBy(node: ts.ClassLikeDeclaration): Port[] {
  const names = (node.heritageClauses ?? [])
    .filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
    .flatMap((clause) => clause.types)
    .map((type) => (ts.isIdentifier(type.expression) ? type.expression.text : ''))
  return PORTS.filter((port) => names.includes(port))
}

/** Every `class X implements <Port>` in `text`, as `{ cls, port, source }`. */
function findImplementers(source: string, text: string): Implementer[] {
  const found: Implementer[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name !== undefined) {
      for (const port of portsImplementedBy(node)) {
        found.push({ cls: node.name.text, port, source })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true))
  return found
}

/** Whether `text` calls `callee(...)` and constructs `cls` with `new cls(...)`. */
function runsSuiteOver(
  text: string,
  callee: string,
  cls: string,
): { calls: boolean; builds: boolean } {
  let calls = false
  let builds = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls ||= node.expression.text === callee
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      builds ||= node.expression.text === cls
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile('t.ts', text, ts.ScriptTarget.Latest, true))
  return { calls, builds }
}

const key = (entry: { cls: string; source: string }): string => `${entry.source}#${entry.cls}`

/** What is wrong between the implementers found and the ledger, in words. */
function ledgerProblems(
  found: readonly Implementer[],
  ledger: readonly LedgerEntry[],
  exempt: readonly Exemption[],
  readTest: (path: string) => string | undefined,
): string[] {
  const foundByKey = new Map(found.map((entry) => [key(entry), entry]))
  const known = new Set([...ledger, ...exempt].map(key))
  const problems: string[] = []

  for (const entry of found) {
    if (!known.has(key(entry))) {
      problems.push(
        `${key(entry)} implements ${entry.port} and runs no ${suiteName(entry.port)}: add a test ` +
          'that does, then ledger it here (or, for a double that is not a keeper store, exempt it with a reason)',
      )
    }
  }
  for (const entry of exempt) {
    if (!foundByKey.has(key(entry))) problems.push(`${key(entry)} is exempted but no longer exists`)
    if (entry.reason.trim().length <= 20) problems.push(`${key(entry)} is exempted with no reason`)
  }
  for (const entry of ledger) {
    const actual = foundByKey.get(key(entry))
    if (actual === undefined) {
      problems.push(`${key(entry)} is ledgered but no longer implements ${entry.port} there`)
      continue
    }
    if (actual.port !== entry.port)
      problems.push(`${key(entry)} implements ${actual.port}, not ${entry.port}`)
    const text = readTest(entry.test)
    if (text === undefined) {
      problems.push(`${entry.test} is gone, so ${entry.cls} runs no conformance suite`)
      continue
    }
    const { calls, builds } = runsSuiteOver(text, suiteName(entry.port), entry.cls)
    if (!calls) problems.push(`${entry.test} no longer calls ${suiteName(entry.port)}`)
    if (!builds)
      problems.push(`${entry.test} never constructs ${entry.cls}, so the suite is not run over it`)
  }
  return problems
}

const SCAN_SRC_DIRS = TEST_SCAN_DIRS.filter(
  (dir) => dir.startsWith('packages/') || dir.startsWith('apps/'),
)
  .map((dir) => join(REPO_ROOT, dir, 'src'))
  .filter((dir) => existsSync(dir))

function realImplementers(): Implementer[] {
  return SCAN_SRC_DIRS.flatMap((dir) => walkSourceFiles(dir)).flatMap((file) =>
    findImplementers(relativeToRepo(file), readFileSync(file, 'utf-8')),
  )
}

const readRepoFile = (path: string): string | undefined => {
  const full = join(REPO_ROOT, path)
  return existsSync(full) ? readFileSync(full, 'utf-8') : undefined
}

describe('every store-port implementer runs its conformance suite', () => {
  describe('the ledger check (self-test over fixtures)', () => {
    const implementer = (cls: string, port: Port = 'BlobStore'): Implementer => ({
      cls,
      port,
      source: `p/${cls}.ts`,
    })
    const entry = (cls: string, port: Port = 'BlobStore'): LedgerEntry => ({
      ...implementer(cls, port),
      test: `p/${cls}.test.ts`,
    })
    const suiteOver = (cls: string, port: Port = 'BlobStore'): string =>
      `${suiteName(port)}(async () => ({ store: new ${cls}() }))`
    const problemsFor = (
      found: Implementer[],
      ledger: LedgerEntry[],
      tests: Record<string, string>,
    ): string[] => ledgerProblems(found, ledger, [], (path) => tests[path])

    it('finds an implementer, whichever clause position the port is in', () => {
      expect(findImplementers('p/a.ts', 'class A implements Base, BlobStore<X> {}')).toEqual([
        { cls: 'A', port: 'BlobStore', source: 'p/a.ts' },
      ])
      expect(findImplementers('p/a.ts', '// class A implements BlobStore\nclass A {}')).toEqual([])
    })

    it('passes an implementer whose test runs the suite over it', () => {
      expect(
        problemsFor([implementer('A')], [entry('A')], { 'p/A.test.ts': suiteOver('A') }),
      ).toEqual([])
    })

    it('fails an implementer with no entry', () => {
      expect(problemsFor([implementer('A')], [], {})).toEqual([
        expect.stringContaining(
          'p/A.ts#A implements BlobStore and runs no describeBlobStoreConformance',
        ),
      ])
    })

    it('fails an entry whose class is gone', () => {
      expect(problemsFor([], [entry('A')], { 'p/A.test.ts': suiteOver('A') })).toEqual([
        expect.stringContaining('no longer implements'),
      ])
    })

    it('fails an entry whose test file is gone', () => {
      expect(problemsFor([implementer('A')], [entry('A')], {})).toEqual([
        expect.stringContaining('is gone'),
      ])
    })

    it('fails a test that stopped calling the matching suite', () => {
      const wrongSuite = suiteOver('A', 'DocumentStore')
      expect(problemsFor([implementer('A')], [entry('A')], { 'p/A.test.ts': wrongSuite })).toEqual([
        expect.stringContaining('no longer calls describeBlobStoreConformance'),
      ])
    })

    it('fails a test that calls the suite over some other class', () => {
      expect(
        problemsFor([implementer('A')], [entry('A')], { 'p/A.test.ts': suiteOver('B') }),
      ).toEqual([expect.stringContaining('never constructs A')])
    })

    it('fails an exemption whose class is gone or that gives no reason', () => {
      const problems = ledgerProblems(
        [],
        [],
        [{ cls: 'F', source: 'p/F.ts', reason: 'short' }],
        () => undefined,
      )
      expect(problems).toHaveLength(2)
    })
  })

  const found = realImplementers()

  it('reaches the implementers it governs', () => {
    // A walk that found nothing reports an empty ledger as complete.
    const production = found.filter(
      (entry) => !/\.(test|spec)\.tsx?$/.test(entry.source) && entry.cls !== '',
    )
    expect(production.length).toBeGreaterThanOrEqual(FLOOR_PRODUCTION_IMPLEMENTERS)
    for (const port of PORTS)
      expect(
        found.some((entry) => entry.port === port),
        port,
      ).toBe(true)
  })

  it('exports each conformance suite from the ports test-utils barrel', () => {
    const barrel = readRepoFile('packages/ports/src/test-utils/index.ts') ?? ''
    for (const port of PORTS) expect(barrel, suiteName(port)).toContain(suiteName(port))
  })

  it('ledgers every implementer, and every entry still holds', () => {
    expect(ledgerProblems(found, CONFORMANCE_LEDGER, NOT_A_STORE, readRepoFile)).toEqual([])
  })

  it('keeps the ledger at the production implementers it was written for', () => {
    expect(CONFORMANCE_LEDGER.length).toBeGreaterThanOrEqual(FLOOR_PRODUCTION_IMPLEMENTERS)
  })
})
