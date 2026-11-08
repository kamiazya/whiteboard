/**
 * QR-33a item 3: no `#[expect]` in the Rust workspace outside a ledger.
 *
 * `crates/expect-ledger.json` counts them per crate per lint. Both sides
 * fail: an expectation the ledger does not list (or lists with a smaller
 * count) is new, and an entry whose count is larger than what the tree holds
 * is stale, so the ledger shrinks when a site is fixed rather than keeping a
 * budget someone can spend again.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ExpectSite, expectSites } from './rust-expect.js'
import { crateDirs, rustSourceFiles } from './rust-source.js'
import { REPO_ROOT } from './scan-roots.js'

interface LedgerEntry {
  readonly crate: string
  readonly lint: string
  readonly count: number
  readonly reason: string
}

const LEDGER = join(REPO_ROOT, 'crates/expect-ledger.json')

const ledger = (JSON.parse(readFileSync(LEDGER, 'utf8')) as { entries: LedgerEntry[] }).entries

/** The deepest crate directory holding `file`. */
function crateOf(file: string, crates: readonly string[]): string | undefined {
  return crates
    .filter((dir) => file.startsWith(`${dir}/`))
    .sort((a, b) => b.length - a.length)
    .at(0)
}

/** `crate\tlint` to the count of sites expecting it, for the given files. */
function countExpectations(
  files: readonly { path: string; text: string }[],
  crates: readonly string[],
): { counts: Map<string, number>; orphans: string[]; reasonless: string[] } {
  const counts = new Map<string, number>()
  const orphans: string[] = []
  const reasonless: string[] = []
  for (const { path, text } of files) {
    const sites: ExpectSite[] = expectSites(text)
    if (sites.length === 0) continue
    const crate = crateOf(path, crates)
    if (crate === undefined) {
      orphans.push(path)
      continue
    }
    for (const site of sites) {
      if (site.reason === undefined || site.reason.trim() === '') {
        reasonless.push(`${path}:${site.line}`)
      }
      for (const lint of site.lints) {
        const key = `${crate}\t${lint}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return { counts, orphans, reasonless }
}

/** Every way the ledger and the counted tree disagree. */
function ledgerProblems(
  entries: readonly LedgerEntry[],
  counts: ReadonlyMap<string, number>,
): string[] {
  const listed = new Map(entries.map((e) => [`${e.crate}\t${e.lint}`, e]))
  const problems: string[] = []
  if (listed.size !== entries.length) problems.push('an entry is listed twice')
  for (const [key, found] of counts) {
    const entry = listed.get(key)
    const [crate, lint] = key.split('\t')
    if (entry === undefined) {
      problems.push(`${crate}: ${found} new #[expect(${lint})] not in the ledger`)
    } else if (found > entry.count) {
      problems.push(`${crate}: ${found} #[expect(${lint})], the ledger allows ${entry.count}`)
    }
  }
  for (const [key, entry] of listed) {
    const found = counts.get(key) ?? 0
    const [crate, lint] = key.split('\t')
    if (found < entry.count) {
      problems.push(
        `${crate}: #[expect(${lint})] is ${found}, the ledger still says ${entry.count}`,
      )
    }
    if (entry.reason.trim() === '') problems.push(`${crate}: ${lint} has no reason`)
    if (entry.count < 1) problems.push(`${crate}: ${lint} has a count below 1`)
  }
  return problems
}

describe('the #[expect] ledger against the tree', () => {
  const files = rustSourceFiles().map((path) => ({
    path,
    text: readFileSync(join(REPO_ROOT, path), 'utf8'),
  }))
  const crates = crateDirs()
  const { counts, orphans, reasonless } = countExpectations(files, crates)

  it('reads the tree: the edge-routing crate is in it and holds the bulk of them', () => {
    // A scan that found nothing would agree with an empty ledger.
    expect(files.length).toBeGreaterThan(40)
    const routing = [...counts]
      .filter(([key]) => key.startsWith('crates/core/edge-routing\t'))
      .reduce((n, [, c]) => n + c, 0)
    expect(routing).toBeGreaterThan(20)
  })

  it('has every expectation in a crate, each with a reason of its own', () => {
    expect(orphans).toEqual([])
    expect(reasonless).toEqual([])
  })

  it('lists exactly what the tree holds', () => {
    expect(ledgerProblems(ledger, counts)).toEqual([])
  })
})

describe('the ledger checker', () => {
  const entry: LedgerEntry = { crate: 'crates/a', lint: 'clippy::float_cmp', count: 2, reason: 'r' }
  const at = (n: number) => new Map([['crates/a\tclippy::float_cmp', n]])

  it('passes an equal count', () => {
    expect(ledgerProblems([entry], at(2))).toEqual([])
  })

  it('fails one more than the ledger allows', () => {
    expect(ledgerProblems([entry], at(3))).toEqual([expect.stringContaining('allows 2')])
  })

  it('fails a stale count after a site is removed', () => {
    expect(ledgerProblems([entry], at(1))).toEqual([expect.stringContaining('still says 2')])
  })

  it('fails an expectation the ledger does not list', () => {
    expect(ledgerProblems([], at(1))).toEqual([expect.stringContaining('not in the ledger')])
  })

  it('counts an inner attribute too, a site once per lint, and ignores an expectation named in a comment or a string', () => {
    const text = [
      '// #[expect(clippy::float_cmp, reason = "a comment")]',
      'const S: &str = "#[expect(clippy::float_cmp, reason = \\"a string\\")]";',
      '#![expect(clippy::float_cmp, reason = "inner")]',
      '#[expect(clippy::cast_sign_loss, clippy::cast_possible_truncation, reason = "both")]',
      'fn f() {}',
    ].join('\n')
    const { counts: found } = countExpectations([{ path: 'crates/a/src/x.rs', text }], ['crates/a'])
    expect([...found]).toEqual([
      ['crates/a\tclippy::float_cmp', 1],
      ['crates/a\tclippy::cast_sign_loss', 1],
      ['crates/a\tclippy::cast_possible_truncation', 1],
    ])
  })

  it('reports an expectation with no reason', () => {
    const { reasonless } = countExpectations(
      [{ path: 'crates/a/src/x.rs', text: '#[expect(clippy::float_cmp)]\nfn f() {}\n' }],
      ['crates/a'],
    )
    expect(reasonless).toEqual(['crates/a/src/x.rs:1'])
  })
})
