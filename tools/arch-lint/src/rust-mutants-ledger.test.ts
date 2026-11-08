import { readFileSync } from 'node:fs'
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
const { EXCLUSIONS, ledgerEntries, ledgerProblems } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/rust-mutants-ledger.mjs')).href
)) as {
  EXCLUSIONS: number
  ledgerEntries: (toml: string) => Entry[]
  ledgerProblems: (entries: Entry[], names: string[], expected?: number) => string[]
}

// .cargo/mutants.toml is the ledger of mutants the Rust mutation gate does
// not judge (QR-17). Whether each entry still matches a mutant needs
// cargo-mutants, so rust-mutants.mjs checks that where it runs; what can be
// read from the file is held here, on every change.

const toml = readFileSync(join(REPO_ROOT, '.cargo/mutants.toml'), 'utf8')
const entries = ledgerEntries(toml)

describe('the Rust mutants ledger', () => {
  it('holds the pinned number of entries, each a literal regex with its reason', () => {
    expect(entries).toHaveLength(EXCLUSIONS)
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
})
