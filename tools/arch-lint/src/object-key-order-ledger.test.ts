/**
 * Every object-key iteration in canvas-render's production source names the
 * key domain it runs over (ADR-0054 decision 11, QR-20a).
 *
 * Why it needs a ledger. `Object.keys`, `Object.entries`, `Object.values` and
 * `for…in` visit integer-like keys FIRST, ascending, and every other key in
 * insertion order — so an object keyed by ids walks `"12"` before `"a"` before
 * `"3x"`, whatever order they arrived in. The Rust port's ordered maps keep
 * insertion order for every key, so such a walk reaching output is a byte
 * difference against the oracle that no golden shows, because no golden has
 * an all-digit id. A `Map` iterates in insertion order for every key and is
 * the safe container; an object walk is safe when its keys can never look
 * like an integer (a namespaced facet key, an SVG attribute name) or when the
 * order cannot reach output (a lookup table, an emptiness check). Each entry
 * says which, so a new walk has to answer the same question.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const WALK =
  /\bObject\s*\.\s*(?:keys|entries|values)\s*\(|\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+in\b/g

interface LedgerEntry {
  readonly uses: number
  readonly why: string
}

const LEDGER: Readonly<Record<string, LedgerEntry>> = {
  'packages/canvas-render/src/layout/canvas-switch.ts': {
    uses: 1,
    why: "the whole layout's differential walking two answers in step: the walk only finds the first path they part at, which reaches a mismatch report and never a scene, so an edge id that looks like an integer moves which difference is named first, not whether one is",
  },
  'packages/canvas-render/src/references/seams.ts': {
    uses: 1,
    why: 'an emptiness check on the resolved seams, where the count is read and the order never is',
  },
  'packages/canvas-render/src/quality/facet-score.ts': {
    uses: 2,
    why: 'facet keys, which the grammar namespaces as namespace.name/vN and so never integer-like, and the channel records, whose keys are fixed words',
  },
  'packages/canvas-render/src/svg/serialize.ts': {
    uses: 1,
    why: 'SVG attribute names, which start with a letter by the XML Name production and so are never integer-like',
  },
  'packages/canvas-render/src/svg/hoist.ts': {
    uses: 2,
    why: 'SVG attribute names, which start with a letter by the XML Name production and so are never integer-like',
  },
  'packages/canvas-render/src/svg/keyed.ts': {
    uses: 1,
    why: 'SVG root attribute names, which start with a letter by the XML Name production and so are never integer-like',
  },
  'packages/canvas-render/src/layout/nodes/node-outline.ts': {
    uses: 1,
    why: 'shape names a contribution registers, which the table composes into namespaced ids before anything is ordered by them',
  },
  'packages/canvas-render/src/layout/canvas-theme.ts': {
    uses: 1,
    why: 'theme names a contribution registers, which the table composes into namespaced ids before anything is ordered by them',
  },
  'packages/canvas-render/src/vendor/budoux/parser.ts': {
    uses: 2,
    why: 'the BudouX model copied into Maps that are only ever looked up by key, so the walk order never reaches a line break',
  },
  'packages/canvas-render/src/tags/declared-colours.ts': {
    uses: 1,
    why: 'an emptiness check on the tag library, where the count is read and the order never is',
  },
}

const REASON = /^(\S+\s+){7,}\S+/

function walksIn(source: string, fileName: string): number {
  return stripCommentsAndStrings(source, fileName).match(WALK)?.length ?? 0
}

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const production = walkSourceFiles(join(REPO_ROOT, 'packages/canvas-render/src'))
  .filter(
    (path) =>
      !isTestPath(path) && !relOf(path).includes('/test-utils/') && !path.includes('.bench.'),
  )
  .map(relOf)
const used = new Map(
  production
    .map((rel): [string, number] => [rel, walksIn(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel)])
    .filter(([, count]) => count !== 0),
)

describe('canvas-render names the key domain of every object-key walk', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(100)
    expect(used.size).toBeGreaterThan(0)
  })

  it('every walk is ledgered with its key domain', () => {
    const unledgered = [...used.keys()].filter((rel) => LEDGER[rel] === undefined)
    expect(
      unledgered,
      'an object walk visits integer-like keys first: use a Map, or ledger why the keys can never look like an integer or the order never reaches output',
    ).toEqual([])
  })

  it('every ledger entry still names exactly the walks it excuses', () => {
    const drifted = Object.entries(LEDGER)
      .filter(([rel, entry]) => (used.get(rel) ?? 0) !== entry.uses)
      .map(([rel, entry]) => `${rel}: ledger ${entry.uses}, source ${used.get(rel) ?? 0}`)
    expect(drifted, 'an entry that outlives its walk is how a ledger stops being read').toEqual([])
  })

  it('every ledger entry gives a reason of at least eight words', () => {
    expect(Object.values(LEDGER).filter((entry) => !REASON.test(entry.why))).toEqual([])
  })

  describe('the scan itself, on planted source', () => {
    it('counts each of the four walks', () => {
      const planted = [
        'export const a = (o: object) => Object.keys(o)',
        'export const b = (o: object) => Object . entries(o)',
        'export const c = (o: object) => Object.values(o)',
        'export function d(o: object) { for (const k in o) void k }',
      ].join('\n')
      expect(walksIn(planted, 'planted.ts')).toBe(4)
    })

    it('is not moved by a comment, a string, a for…of or a Map', () => {
      const planted = [
        '// Object.keys visits integer keys first',
        "export const note = 'for (const k in o)'",
        'export function e(m: Map<string, number>) { for (const k of m.keys()) void k }',
      ].join('\n')
      expect(walksIn(planted, 'planted.ts')).toBe(0)
    })
  })
})
