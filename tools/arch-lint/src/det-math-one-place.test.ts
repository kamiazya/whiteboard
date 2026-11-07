/**
 * canvas-render calls no transcendental `Math` function outside its
 * `det-math.ts` (ADR-0054 decision 11, QR-20a).
 *
 * Why it needs a scan. ECMAScript leaves `Math.hypot`, `Math.sin` and the rest
 * implementation-approximated: V8 answers about one input in a hundred one
 * ulp away from fdlibm, which the Rust port uses, and a one-ulp difference
 * flips a routing tie-break or the last digit `formatCoord` prints. Nothing
 * else notices: every golden is taken on one engine, so it agrees with
 * whatever that engine answers. `det-math.ts` pins `hypot` to
 * `sqrt(dx*dx + dy*dy)` and `sin`/`cos` to fdlibm; a call written straight to
 * `Math` is the only way back in, so the rule is about where one may appear.
 * `Math.sqrt` and the other correctly rounded operations are not listed.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const CALL =
  /\bMath\s*\??\.\s*(?:hypot|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt)\b/g

interface LedgerEntry {
  readonly uses: number
  readonly why: string
}

/** Each entry is held from both sides: a count that stops matching fails. */
const LEDGER: Readonly<Record<string, LedgerEntry>> = {
  'packages/canvas-render/src/layout/edges/edge-jumps.ts': {
    uses: 1,
    why: 'Math.log2 is only the first guess of a grid level that the two loops after it correct against cellAt, so its last bit cannot reach the answer',
  },
}

const DET_MATH = 'packages/canvas-render/src/det-math.ts'
const REASON = /^(\S+\s+){7,}\S+/

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const production = walkSourceFiles(join(REPO_ROOT, 'packages/canvas-render/src'))
  .filter((path) => !isTestPath(path) && !relOf(path).includes('/test-utils/'))
  .map(relOf)

function usesIn(source: string, fileName: string): number {
  return stripCommentsAndStrings(source, fileName).match(CALL)?.length ?? 0
}

const used = new Map(
  production
    .filter((rel) => rel !== DET_MATH)
    .map((rel): [string, number] => [rel, usesIn(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel)])
    .filter(([, count]) => count !== 0),
)

describe('canvas-render reaches transcendental math only through det-math', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(100)
    expect(production).toContain(DET_MATH)
  })

  it('no production source calls one outside det-math or the ledger', () => {
    const unledgered = [...used.keys()].filter((rel) => LEDGER[rel] === undefined)
    expect(
      unledgered,
      'import hypot / sin / cos from det-math.ts: Math.hypot and Math.sin answer differently from the Rust port',
    ).toEqual([])
  })

  it('every ledger entry still names exactly the uses it excuses', () => {
    const drifted = Object.entries(LEDGER)
      .filter(([rel, entry]) => (used.get(rel) ?? 0) !== entry.uses)
      .map(([rel]) => rel)
    expect(drifted, 'an entry that outlives its call is how a ledger stops being read').toEqual([])
  })

  it('every ledger entry gives a reason of at least eight words', () => {
    expect(Object.values(LEDGER).filter((entry) => !REASON.test(entry.why))).toEqual([])
  })

  describe('the scan itself, on planted source', () => {
    it('counts a call, a spaced member access and an exponential', () => {
      const planted = [
        'export const a = (x: number, y: number) => Math.hypot(x, y)',
        'export const b = (x: number) => Math . sin(x) + Math.exp(x)',
        'export const c = (x: number) => Math?.cos(x)',
      ].join('\n')
      expect(usesIn(planted, 'planted.ts')).toBe(4)
    })

    it('is not moved by a comment, a string, Math.sqrt or a det import', () => {
      const planted = [
        '// Math.hypot rounds differently',
        "export const note = 'Math.cos is banned'",
        "import { hypot } from './det-math.js'",
        'export const c = (x: number, y: number) => hypot(x, y) + Math.sqrt(x)',
      ].join('\n')
      expect(usesIn(planted, 'planted.ts')).toBe(0)
    })
  })
})
