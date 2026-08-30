import { describe, expect, it } from 'vitest'
import { MUTATED } from '../stryker-targets.mjs'

/**
 * The mutation lane covers a LIST of modules, not the package, and a list's
 * failure mode is silence: a module added next month is simply not covered,
 * the weekly report still looks healthy, and nothing anywhere says the lane
 * has been looking at less and less of the code.
 *
 * So both halves are pinned EXACTLY — the same instrument shape as this
 * package's quality scoreboards, where an improvement is as loud as a
 * regression. Adding a production source file fails this test until someone
 * decides IN THE DIFF whether the lane should cover it; the answer may well be
 * "no", and then the count moves and the decision is on the record.
 *
 * Deliberately not "every file must be listed": mutating all 47 of them is
 * 9089 mutants, several hours at this package's measured rate, so the lane's
 * scope is a budget. This test does not argue with the budget. It only makes
 * spending it a choice rather than an oversight.
 */
const sources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/** Production sources: not tests, and not the fixtures/arbitraries they share. */
function isProductionSource(path: string): boolean {
  return !path.includes('.test.') && !path.startsWith('./test-utils/')
}

describe('the mutation lane covers what it says it covers', () => {
  const production = Object.keys(sources).filter(isProductionSource).sort()

  it('scans a package worth scanning', () => {
    // The guard above is worthless if the glob ever stops matching: an empty
    // scan agrees with every count.
    expect(production.length).toBeGreaterThan(30)
  })

  it('names exactly the modules it mutates, out of exactly this many', () => {
    expect({ mutated: MUTATED.length, production: production.length }).toEqual({
      mutated: 9,
      production: 47,
    })
  })

  it('lists only files that exist, at their real paths', () => {
    // The other direction: a renamed or deleted module leaves an entry that
    // silently mutates nothing, which reads exactly like a covered file.
    const onDisk = new Set(production.map((path) => path.replace(/^\.\//, 'src/')))
    expect(MUTATED.filter((entry: string) => !onDisk.has(entry))).toEqual([])
  })

  it('excludes seed.ts, whose survivors this tool reports falsely', () => {
    // Pinned rather than left to the comment beside it: this exclusion is the
    // one that would look like an oversight to the next reader, and re-adding
    // it puts known-wrong rows in front of an author.
    expect(MUTATED).not.toContain('src/layout/seed.ts')
  })
})
