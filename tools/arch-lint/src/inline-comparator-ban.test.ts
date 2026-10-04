/**
 * An order over strings is `compareCodeUnit`, not a ternary written beside the
 * sort, in shipped package and web-app source.
 *
 * `compareCodeUnit` (`model`) says it is the one definition of the order, and a
 * comparator whose whole value is determinism is the last thing that should
 * exist in several spellings. The inline form also answers `1` on a tie, which
 * is no order at all: `a < b ? -1 : 1` calls two equal keys each greater than
 * the other, so the result depends on which one the engine happened to compare
 * first.
 *
 * Read from the syntax tree, so a comment that quotes the idiom is not a use.
 * The ledger is for a package that may not import `model`; each entry is
 * guarded from both sides, so one cannot outlive the copy it excuses.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inlineComparators } from './inline-comparator-scan.js'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

interface LedgerEntry {
  readonly uses: number
  readonly why: string
}

const LEDGER: Readonly<Record<string, LedgerEntry>> = {
  'packages/model/src/compare.ts': {
    uses: 1,
    why: 'the one definition itself, which every other site is meant to call rather than restate',
  },
  'packages/facet-engine/src/code-unit-order.ts': {
    uses: 1,
    why: 'facet-engine may depend on zod alone, so it cannot import the comparator from model and restates the one-liner once',
  },
}

const REASON = /^(\S+\s+){7,}\S+/

function shippedSource(): readonly string[] {
  return [
    ...walkSourceFiles(join(REPO_ROOT, 'packages')),
    ...walkSourceFiles(join(REPO_ROOT, 'apps/web/src')),
  ]
    .map((absolute) => relative(REPO_ROOT, absolute).split(sep).join('/'))
    .filter((path) => /^(packages\/[^/]+|apps\/web)\/src\//.test(path) && isShippedPath(path))
}

const files = shippedSource()
const used = new Map(
  files
    .map((path): [string, number] => [
      path,
      inlineComparators(path, readFileSync(join(REPO_ROOT, path), 'utf8')),
    ])
    .filter(([, count]) => count !== 0),
)

describe('an order over strings is not spelled out beside the sort', () => {
  it('scans a tree worth scanning', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((path) => path.startsWith('apps/web/src/'))).toBe(true)
  })

  it('every inline comparator is a ledgered exception', () => {
    const unledgered = [...used.keys()].filter((path) => LEDGER[path] === undefined)
    expect(
      unledgered,
      'use `compareCodeUnit` from @kamiazya/whiteboard-model: the inline form calls equal keys each greater than the other',
    ).toEqual([])
  })

  it('every ledger entry still names exactly the copies it excuses', () => {
    const drifted = Object.entries(LEDGER)
      .filter(([path, entry]) => (used.get(path) ?? 0) !== entry.uses)
      .map(([path]) => path)
    expect(drifted, 'an entry that outlives its copy is how a ledger stops being read').toEqual([])
  })

  it('every ledger entry gives a reason of at least eight words', () => {
    const bare = Object.entries(LEDGER)
      .filter(([, entry]) => !REASON.test(entry.why))
      .map(([path]) => path)
    expect(bare).toEqual([])
  })

  describe('the scan itself, on planted source', () => {
    const count = (source: string): number => inlineComparators('planted.ts', source)

    it('sees the ternary in an arrow, a function expression and a declaration', () => {
      expect(count('xs.sort((a, b) => (a < b ? -1 : 1))')).toBe(1)
      expect(count('xs.sort(function (a, b) { return a > b ? 1 : -1 })')).toBe(1)
      expect(
        count('function byKey(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0 }'),
      ).toBe(1)
    })

    it('sees one in a destructuring comparator and behind a named binding', () => {
      expect(count('xs.sort(([a], [b]) => (a < b ? -1 : 1))')).toBe(1)
      expect(count('const byKey = (a: K, b: K) => (a.key < b.key ? -1 : 1)')).toBe(1)
    })

    it('sees a comparator written as a class method or an object method', () => {
      expect(count('class C { compare(a: K, b: K) { return a.k < b.k ? -1 : 1 } }')).toBe(1)
      expect(count('const o = { byKey(a: K, b: K) { return a.k < b.k ? -1 : 1 } }')).toBe(1)
      expect(count('class C { size(a: K, b: K) { return a.k < b.k ? -1 : 1 } }')).toBe(0)
    })

    it('sees the statement form once per comparator, with or without a tie answer', () => {
      expect(count('xs.sort((a, b) => { if (a < b) return -1; return 1 })')).toBe(1)
      expect(count('xs.sort((a, b) => { if (a < b) { return -1 } return 1 })')).toBe(1)
      expect(count('xs.sort((a, b) => { if (a.k > b.k) return 1; return -1 })')).toBe(1)
      expect(
        count('xs.sort((a, b) => { if (a < b) return -1; if (a > b) return 1; return 0 })'),
      ).toBe(1)
      expect(
        count('xs.sort((a, b) => { if (a < b) return -1; else if (a > b) return 1; return 0 })'),
      ).toBe(1)
      expect(count('function byKey(a: K, b: K) { if (a.k < b.k) return -1; return 1 }')).toBe(1)
    })

    it('looks through parentheses and casts around the condition and the sign', () => {
      expect(count('xs.sort((a, b) => ((a < b) ? -1 : 1))')).toBe(1)
      expect(count('xs.sort((a, b) => { if (a < b) return (-1 as number); return 1 })')).toBe(1)
    })

    it('leaves a sign test in the statement form, and a function that orders nothing, alone', () => {
      expect(count('xs.sort((a, b) => { if (a.dx < 0) return -1; return 1 })')).toBe(0)
      expect(count('xs.sort((a, b) => { if (0 < a.dx) return 1; return -1 })')).toBe(0)
      expect(
        count('const pick = (a: number, b: number) => { if (a < b) return -1; return 1 }'),
      ).toBe(0)
      expect(count('xs.sort((a, b) => { if (a < b) return 5; return 1 })')).toBe(0)
      expect(count('xs.sort((a, b) => { if (a < b) log(); return 0 })')).toBe(0)
    })

    it('sees an equality-first ternary as the same comparator, and counts a chain once', () => {
      expect(count('xs.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))')).toBe(1)
      expect(count('xs.sort((a, b) => (a.k == b.k ? 0 : a.k > b.k ? 1 : -1))')).toBe(1)
      expect(count('xs.sort((a, b) => (a === b ? 0 : (a < b ? -1 : 1)))')).toBe(1)
      expect(count('xs.sort((a, b) => (a === b ? 0 : b < a ? 1 : -1) as number)')).toBe(1)
      // an equality ternary that does not lead into an order is not one
      expect(count('xs.sort((a, b) => (a === b ? 0 : 1))')).toBe(0)
      expect(count('xs.sort((a, b) => (a.k === 0 ? 0 : a < b ? -1 : 1))')).toBe(1)
    })

    it('leaves a ternary on a number literal alone even where the function is a comparator', () => {
      expect(count('xs.sort((a, b) => (a.dx < 0 ? -1 : 1))')).toBe(0)
      expect(count('const byTurn = (a: P, b: P) => (0 < a.dx ? 1 : -1)')).toBe(0)
      expect(count('xs.sort((a, b) => (a.k < b.k ? -1 : 1))')).toBe(1)
    })

    it('leaves the model comparator, a sign test and prose alone', () => {
      expect(count('xs.sort((a, b) => compareCodeUnit(a, b))')).toBe(0)
      expect(count('const sign = (x: number) => (x < 0 ? -1 : 1)')).toBe(0)
      expect(count('const turn = (a: number, b: number) => (a > 0 ? 1 : -1)')).toBe(0)
      expect(count('const pick = (a: number, b: number) => (a < b ? -1 : 1)')).toBe(0)
      expect(count('// xs.sort((a, b) => (a < b ? -1 : 1))\nexport const x = 1')).toBe(0)
    })
  })
})
