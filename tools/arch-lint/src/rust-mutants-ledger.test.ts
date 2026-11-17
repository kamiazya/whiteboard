import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

interface Entry {
  regex: string
  literal: boolean
  reason: string
}
// Loaded by URL like affected.test.ts loads affected.mjs: tools/checks is a
// workspace of its own, and a relative import across it is an escape.
const {
  cargoShard,
  ledgerEntries,
  ledgerProblems,
  mutantNames,
  prExcludeGlobs,
  prExcludeProblems,
  shardPlan,
} = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/rust-mutants-ledger.mjs')).href
)) as {
  ledgerEntries: (toml: string) => Entry[]
  ledgerProblems: (entries: Entry[], names: string[], expected?: number) => string[]
  mutantNames: (stdout: string) => string[]
  cargoShard: (leg: string | undefined) => string | undefined | Error
  prExcludeGlobs: (text: string) => string[]
  prExcludeProblems: (globs: string[], exists: (path: string) => boolean) => string[]
  shardPlan: (input: { event: string; scopeRuns: boolean; mutantCount: number | null }) => number[]
}

/** Every leg, as push, the schedule and an unreadable count plan. */
const FULL_SET = 8

// .cargo/mutants.toml is the ledger of mutants the Rust mutation gate does
// not judge (QR-17). Whether each entry still matches a mutant needs
// cargo-mutants, so rust-mutants.mjs checks that where it runs; what can be
// read from the file is held here, on every change.

const toml = readFileSync(join(REPO_ROOT, '.cargo/mutants.toml'), 'utf8')
const entries = ledgerEntries(toml)

describe('the Rust mutants ledger', () => {
  it('holds the pinned number of entries, each a literal regex with its reason', () => {
    expect(entries.length).toBeGreaterThan(0)
    const names = entries.map((e) => `${e.regex}x`)
    // Every real entry is judged here against a name made to match it, so
    // only the count, literal and reason rules can fail.
    expect(ledgerProblems(entries, names).filter((p) => !p.includes('stale'))).toEqual([])
  })

  it('fails an entry with no reason, one that matches nothing, and a changed count', () => {
    const one = ledgerEntries(
      `exclude_re = [\n  # why this mutant cannot be observed by a test\n  '^a\\.rs:',\n  'b',\n]\n`,
    )
    expect(one.map((e) => e.regex)).toEqual(['^a\\.rs:', 'b'])
    const problems = ledgerProblems(one, ['a.rs:1:1: replace f'], 2)
    expect(problems).toEqual([
      'b: an exclusion with no reason above it',
      'b: matches no mutant, so it is stale',
    ])
    expect(ledgerProblems(one.slice(0, 1), ['a.rs:1:1: x'], 2)[0]).toContain('pins 2')
  })

  it('matches an entry against the plain name when the list output is coloured', () => {
    const coloured =
      'crates/x.rs:1:5: replace \u001b[38;5;13mmeasure\u001b[0m \u001b[35m-> T\u001b[0m with x\n\n'
    const names = mutantNames(coloured)
    expect(names).toEqual(['crates/x.rs:1:5: replace measure -> T with x'])
    const entry = {
      regex: '^crates/x\\.rs:\\d+:\\d+: replace measure -> ',
      literal: true,
      reason: 'a reason long enough to pass',
    }
    expect(ledgerProblems([entry], names, 1)).toEqual([])
  })

  it('runs every cargo-mutants shard once across legs numbered from 1', () => {
    expect([1, 2, 3, 4].map((k) => cargoShard(`${k}/4`))).toEqual(['0/4', '1/4', '2/4', '3/4'])
    expect(cargoShard(undefined)).toBeUndefined()
    expect(cargoShard('0/4')).toBeInstanceOf(Error)
    expect(cargoShard('5/4')).toBeInstanceOf(Error)
  })
})

describe('the shard plan of a pull request', () => {
  const pr = (mutantCount: number | null, scopeRuns = true) =>
    shardPlan({ event: 'pull_request', scopeRuns, mutantCount })

  it('gives a change that touches a mutant at least one shard, never none', () => {
    for (const count of [1, 2, 6, 7, 48, 49, 500]) {
      expect(pr(count).length, `${count} mutants`).toBeGreaterThanOrEqual(1)
    }
  })

  it('numbers the legs from 1 up to the count and never past the cap', () => {
    expect(pr(1)).toEqual([1])
    expect(pr(7)).toEqual([1, 2])
    expect(pr(500)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('runs no shard when the diff holds no mutant or the scope does not reach the job', () => {
    expect(pr(0)).toEqual([])
    expect(pr(30, false)).toEqual([])
  })

  it('fails closed to the full set when the count is unknown', () => {
    expect(pr(null)).toHaveLength(FULL_SET)
    expect(pr(Number.NaN)).toHaveLength(FULL_SET)
    expect(pr(-1)).toHaveLength(FULL_SET)
  })

  it.each([
    'push',
    'schedule',
    'merge_group',
    'workflow_dispatch',
  ])('keeps the full set on %s, whatever the diff holds', (event) => {
    expect(shardPlan({ event, scopeRuns: false, mutantCount: 0 })).toHaveLength(FULL_SET)
  })
})

// cargo-mutants applies `exclude_globs` from the config to EVERY run, so a
// file excused only in-diff cannot live there: the full run would skip it too.
describe('the in-diff-only exclusions', () => {
  const list = prExcludeGlobs(
    readFileSync(join(REPO_ROOT, '.cargo/mutants-pr-exclude.txt'), 'utf8'),
  )

  it('are not in the config, which every run reads', () => {
    expect(toml).not.toMatch(/^\s*exclude_globs\s*=/m)
  })

  it('name only files that exist, once each, and the vendored parser is among them', () => {
    expect(list.length).toBeGreaterThan(50)
    expect(list).toContain('crates/core/markdown/src/vendored/tokenizer.rs')
    expect(prExcludeProblems(list, (p) => existsSync(join(REPO_ROOT, p)))).toEqual([])
  })

  it('fails a wildcard, a missing file and a repeat', () => {
    const problems = prExcludeProblems(
      ['crates/a/*.rs', 'crates/b.rs', 'crates/c.rs', 'crates/c.rs'],
      (p) => p !== 'crates/b.rs',
    )
    expect(problems).toEqual([
      'crates/a/*.rs: not a path to one Rust source file',
      'crates/b.rs: names no file, so it is stale',
      'crates/c.rs: listed twice',
    ])
    expect(prExcludeGlobs('# why\n\n  crates/x.rs  \n')).toEqual(['crates/x.rs'])
  })
})
