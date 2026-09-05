import { describe, expect, it } from 'vitest'
import { KNOWN_EQUIVALENT, MUTATED } from '../stryker-targets.mjs'

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

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * The original halves a `KNOWN_EQUIVALENT` key could be split into.
 *
 * A key is `Mutator: <original> -> <replacement>` and BOTH halves may contain
 * a literal ` -> ` of their own — an arrow function is the obvious case — so
 * there is no split that is right by construction. Every candidate is returned
 * and the caller accepts the entry if any of them is in the file. That is
 * deliberately permissive in the ambiguous case and exact in the one that
 * matters: when the expression is gone from the file, no split matches.
 */
function originalsOf(key: string): readonly string[] {
  const body = key.replace(/^[A-Za-z]+: /, '')
  const splits: string[] = []
  for (let at = body.indexOf(' -> '); at !== -1; at = body.indexOf(' -> ', at + 1)) {
    splits.push(body.slice(0, at))
  }
  return splits
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
      mutated: 10,
      production: 55,
    })
  })

  it('lists only files that exist, at their real paths', () => {
    // The other direction: a renamed or deleted module leaves an entry that
    // silently mutates nothing, which reads exactly like a covered file.
    const onDisk = new Set(production.map((path) => path.replace(/^\.\//, 'src/')))
    expect(MUTATED.filter((entry: string) => !onDisk.has(entry))).toEqual([])
  })

  it('records equivalents only for files the lane actually mutates', () => {
    // An entry for a file outside `MUTATED` suppresses nothing and reads as
    // triage that happened. The likely way to get one is renaming a module and
    // updating only the list above.
    const covered = new Set(MUTATED)
    expect(Object.keys(KNOWN_EQUIVALENT).filter((file) => !covered.has(file))).toEqual([])
  })

  it('records a positive count for every equivalent it names', () => {
    // A zero or negative count suppresses nothing while looking like it does,
    // which is the one way this ledger can quietly stop working.
    const bad = Object.entries(KNOWN_EQUIVALENT).flatMap(([file, mutants]) =>
      Object.entries(mutants)
        .filter(([, count]) => !Number.isInteger(count) || count < 1)
        .map(([key]) => `${file} :: ${key}`),
    )
    expect(bad).toEqual([])
  })

  it('names an expression that is still in the file it names', () => {
    // The way this ledger actually decays. The two guards above catch a moved
    // FILE; nothing catches a moved EXPRESSION, and that is the common edit —
    // rewrite a condition in `edge-crossing-sweep.ts` and its entries match no
    // mutant ever again, while the ledger goes on claiming 23 settled findings
    // and the report goes on being read as if they were still true.
    //
    // Same both-sides discipline as `arch-lint`'s allowlists: an entry cannot
    // outlive the thing it names. The check is a whitespace-flattened
    // substring, which is what `mutantKey` compares anyway — Stryker reports
    // the original slice from its own location, so an expression the file
    // still contains is present verbatim modulo indentation.
    const stale = Object.entries(KNOWN_EQUIVALENT).flatMap(([file, mutants]) => {
      const source = flatten(sources[file.replace(/^src\//, './')] ?? '')
      return Object.keys(mutants)
        .filter((key) => !originalsOf(key).some((original) => source.includes(original)))
        .map((key) => `${file} :: ${key}`)
    })
    expect(stale).toEqual([])
  })

  it('excludes seed.ts, whose survivors this tool reports falsely', () => {
    // Pinned rather than left to the comment beside it: this exclusion is the
    // one that would look like an oversight to the next reader, and re-adding
    // it puts known-wrong rows in front of an author.
    expect(MUTATED).not.toContain('src/layout/seed.ts')
  })
})
