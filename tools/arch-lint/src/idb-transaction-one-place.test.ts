/**
 * apps/web opens an IndexedDB transaction in ONE place, `lib/idb-tx.ts`'s
 * `inTransaction`, and this scan is the executable half of that.
 *
 * Why it needs a scan. A port's atomicity guarantee is bought by the shape of
 * the promise around a transaction, and a hand-rolled copy buys it slightly
 * differently. The copies this replaced failed both ways the shape can: one
 * resolved on its request's success, so a write the browser later aborted was
 * reported as done; another set no abort handler, so an abort left its promise
 * pending forever. `inTransaction` settles on commit and rejects on abort, and
 * every reader written by copying the nearest example should be copying it.
 *
 * It reads the syntax tree for a call of a method named `transaction`, so a
 * comment or a string mentioning one is not a hit. The upgrade path's
 * version-change transaction is not a call — it is the open request's
 * `transaction` PROPERTY — so it needs no entry. Every other site is
 * allowlisted with its reason and exact call count, both-sided.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const SCANNED = 'apps/web/src'
const HELPER = 'apps/web/src/lib/idb-tx.ts'

/** Relative path -> how many `.transaction(` calls the file holds, and why. Both-sided. */
const ALLOWLIST: Readonly<Record<string, { calls: number; why: string }>> = {
  [HELPER]: {
    calls: 1,
    why: 'the one transaction promise: settles on commit, rejects on error and abort',
  },
  'apps/web/src/lib/workspace-tombstone.ts': {
    calls: 1,
    why: 'a read-only refusal whose two answers both arrive through `request`, so there is no commit for it to report early; convertible to `inTransaction` without a change in behaviour',
  },
}

/** Every call of a method named `transaction` in the file, as its source text. */
function transactionCalls(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isPropertyAccessChain(node.expression)) &&
      node.expression.name.text === 'transaction'
    ) {
      found.push(node.getText(file))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const files = walkSourceFiles(join(REPO_ROOT, SCANNED)).map(relOf).filter(isShippedPath)
// Parsed at module scope: the walk parses every shipped apps/web file, which
// measured 3.6s in a test body on a loaded machine — near vitest's 5s default,
// where a timeout would read as a violation. Collection has no such bound.
const callsByFile: ReadonlyMap<string, string[]> = new Map(
  files.map((rel) => [rel, transactionCalls(rel, readFileSync(join(REPO_ROOT, rel), 'utf8'))]),
)
const callsIn = (rel: string): string[] => callsByFile.get(rel) ?? []

describe('apps/web opens an IndexedDB transaction in one place', () => {
  it('scans a tree worth scanning', () => {
    expect(files.length).toBeGreaterThan(300)
    expect(files).toContain(HELPER)
  })

  it('no other shipped source opens a transaction', () => {
    const hits = files
      .filter((rel) => ALLOWLIST[rel] === undefined)
      .flatMap((rel) => callsIn(rel).map((call) => `${rel}: ${call}`))
    expect(
      hits,
      "go through idb-tx's `inTransaction` + `request`: a hand-rolled transaction promise can settle before the commit, or never settle on an abort",
    ).toEqual([])
  })

  it.each([
    ['a plain call', "db.transaction('meta', 'readonly')"],
    ['an optional call', "db?.transaction(['a', 'b'], 'readwrite')"],
    ['a call off a property', 'this.db.transaction(stores)'],
  ])('recognises %s', (_label, source) => {
    expect(transactionCalls('fixture.ts', source)).toHaveLength(1)
  })

  it('does not read the version-change transaction property, or a mention', () => {
    expect(
      transactionCalls(
        'fixture.ts',
        "const tx = req.transaction\n// db.transaction(x)\nconst s = 'db.transaction()'",
      ),
    ).toEqual([])
  })

  it('an allowlisted file opens exactly as many as its entry records', () => {
    const drift = Object.entries(ALLOWLIST).flatMap(([rel, { calls }]) => {
      const found = callsIn(rel)
      return found.length === calls ? [] : [`${rel}: ${calls} recorded, ${found.length} found`]
    })
    expect(drift, 'an allowlist entry covers the sites it names, not the whole file').toEqual([])
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(2)
  })
})
