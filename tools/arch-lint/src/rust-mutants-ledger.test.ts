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
  workspaceMembers,
  packageList,
} = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/rust-mutants-ledger.mjs')).href
)) as {
  ledgerEntries: (toml: string) => Entry[]
  ledgerProblems: (entries: Entry[], names: string[], expected?: number) => string[]
  mutantNames: (stdout: string) => string[]
  cargoShard: (leg: string | undefined) => string | undefined | Error
  prExcludeGlobs: (text: string) => string[]
  prExcludeProblems: (globs: string[], exists: (path: string) => boolean) => string[]
  shardPlan: (input: {
    event: string
    scopeRuns: boolean
    mutants: string[] | null
    members: Member[] | null
  }) => Leg[]
  workspaceMembers: (metadata: Metadata) => Member[]
  packageList: (list: string | undefined) => string[] | Error
}

interface Member {
  name: string
  dir: string
  dependsOn: string[]
}
interface Leg {
  leg: string
  key: string
  shard: string
  packages: string
  tests: string
}
interface Metadata {
  workspace_root: string
  packages: {
    name: string
    manifest_path: string
    dependencies: { name: string; kind: string | null }[]
  }[]
}

/** Every leg, as push, the schedule and an unreadable plan input plan. */
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

/**
 * `cargo metadata --no-deps`' shape for a made-up workspace: each package's
 * directory, its normal dependencies and its dev-dependencies.
 */
function graph(
  crates: Record<string, { dir: string; deps?: string[]; devDeps?: string[]; external?: string[] }>,
): Member[] {
  return workspaceMembers({
    workspace_root: '/w',
    packages: Object.entries(crates).map(([name, c]) => ({
      name,
      manifest_path: `/w/${c.dir}/Cargo.toml`,
      dependencies: [
        ...(c.deps ?? []).map((d) => ({ name: d, kind: null })),
        ...(c.devDeps ?? []).map((d) => ({ name: d, kind: 'dev' })),
        ...(c.external ?? []).map((d) => ({ name: d, kind: null })),
      ],
    })),
  })
}

/** What this repository's graph looks like in the way that matters: a leaf, a chain and a dev edge. */
const members = graph({
  det: { dir: 'crates/core/det' },
  search: { dir: 'crates/core/search', deps: ['det', 'model'], external: ['serde_json'] },
  model: { dir: 'crates/core/model' },
  edge: { dir: 'crates/core/edge', deps: ['det'] },
  wasm: { dir: 'crates/bindings/wasm', deps: ['edge'] },
  oracle: { dir: 'crates/testing/oracle', devDeps: ['model'] },
  tool: { dir: 'crates/xtask' },
  lonely: { dir: 'crates/core/lonely' },
})

const mutant = (file: string, at = '1:1') => `${file}:${at}: replace f -> bool with true`
const mutantsIn = (file: string, count: number) =>
  Array.from({ length: count }, (_, i) => mutant(file, `${i + 1}:1`))

describe('the legs of a pull request', () => {
  const pr = (mutants: string[] | null, scopeRuns = true, m: Member[] | null = members) =>
    shardPlan({ event: 'pull_request', scopeRuns, mutants, members: m })
  const testsOf = (legs: Leg[]) => [...new Set(legs.map((l) => l.tests))]

  it('reads a member by its directory and its workspace dependencies alone', () => {
    expect(members.find((m) => m.name === 'search')).toEqual({
      name: 'search',
      dir: 'crates/core/search',
      dependsOn: ['det', 'model'],
    })
  })

  it('judges a crate nothing depends on by its own tests alone', () => {
    const legs = pr([mutant('crates/core/lonely/src/lib.rs')])
    expect(legs).toEqual([
      { leg: '1/1 lonely', key: 'lonely-1of1', shard: '1/1', packages: 'lonely', tests: 'lonely' },
    ])
  })

  it('judges a crate by every workspace member that depends on it, transitively', () => {
    const legs = pr([mutant('crates/core/edge/src/route.rs')])
    expect(testsOf(legs)).toEqual(['edge wasm'])
    expect(testsOf(pr([mutant('crates/core/det/src/fdlibm.rs')]))).toEqual(['det edge search wasm'])
  })

  it('finds a dependent however far down the manifest order lists it', () => {
    const backwards = graph({
      top: { dir: 'crates/top', deps: ['middle'] },
      middle: { dir: 'crates/middle', deps: ['base'] },
      base: { dir: 'crates/base' },
    })
    expect(testsOf(pr([mutant('crates/base/src/a.rs')], true, backwards))).toEqual([
      'base middle top',
    ])
  })

  it('counts a dev-dependency as a dependent and a dependency of the mutated crate as none', () => {
    expect(testsOf(pr([mutant('crates/core/model/src/lib.rs')]))).toEqual(['model oracle search'])
    // search depends on det and model, so neither's tests are search's; an
    // external crate in its manifest is no workspace member at all.
    expect(testsOf(pr([mutant('crates/core/search/src/cluster.rs')]))).toEqual(['search'])
  })

  it('names a member by the longest directory that holds the file', () => {
    const nested = graph({
      outer: { dir: 'crates/outer' },
      inner: { dir: 'crates/outer/inner' },
      sibling: { dir: 'crates/outer-sibling' },
    })
    expect(testsOf(pr([mutant('crates/outer/inner/src/a.rs')], true, nested))).toEqual(['inner'])
    expect(testsOf(pr([mutant('crates/outer/src/a.rs')], true, nested))).toEqual(['outer'])
    expect(testsOf(pr([mutant('crates/outer-sibling/src/a.rs')], true, nested))).toEqual([
      'sibling',
    ])
  })

  it('plans each mutated package its own legs, never one package under another test set', () => {
    const legs = pr([
      ...mutantsIn('crates/core/lonely/src/lib.rs', 2),
      ...mutantsIn('crates/core/edge/src/route.rs', 3),
    ])
    expect(legs.map((l) => [l.packages, l.tests])).toEqual([
      ['edge', 'edge wasm'],
      ['lonely', 'lonely'],
    ])
  })

  it('gives no leg more mutants than the ceiling, however few tests judge them', () => {
    // 40 members: one tested by itself alone would run 240 a leg by the ratio,
    // which is how 121 of `whiteboard-mcp`'s mutants landed on one leg and ran
    // past the job's 40-minute timeout.
    const many = graph(
      Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`m${n}`, { dir: `crates/m${n}` }])),
    )
    expect(pr(mutantsIn('crates/m0/src/lib.rs', 40), true, many).map((l) => l.shard)).toEqual([
      '1/1',
    ])
    expect(pr(mutantsIn('crates/m0/src/lib.rs', 121), true, many).map((l) => l.shard)).toEqual([
      '1/4',
      '2/4',
      '3/4',
      '4/4',
    ])
  })

  it('gives a group judged by fewer tests more mutants per leg than one judged by all', () => {
    // 8 members: a group tested by all of them runs 6 a leg, one tested by a
    // single member 40 (the ratio's 48, held to the ceiling).
    const wide = graph({
      base: { dir: 'crates/base' },
      ...Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7].map((n) => [`user${n}`, { dir: `crates/u${n}`, deps: ['base'] }]),
      ),
    })
    expect(pr(mutantsIn('crates/base/src/lib.rs', 12), true, wide).map((l) => l.shard)).toEqual([
      '1/2',
      '2/2',
    ])
    expect(pr(mutantsIn('crates/u1/src/lib.rs', 40), true, wide).map((l) => l.shard)).toEqual([
      '1/1',
    ])
    expect(pr(mutantsIn('crates/u1/src/lib.rs', 41), true, wide).map((l) => l.shard)).toEqual([
      '1/2',
      '2/2',
    ])
  })

  it("numbers a package's legs from 1 up to its count and never past the cap", () => {
    const legs = pr(mutantsIn('crates/core/det/src/fdlibm.rs', 500))
    expect(legs.map((l) => l.shard)).toEqual(Array.from({ length: 16 }, (_, i) => `${i + 1}/16`))
    expect(new Set(legs.map((l) => l.key)).size).toBe(16)
  })

  it('runs no leg when the diff holds no mutant or the scope does not reach the job', () => {
    expect(pr([])).toEqual([])
    expect(pr(mutantsIn('crates/core/lonely/src/lib.rs', 30), false)).toEqual([])
  })

  it('fails closed to the whole workspace when the list, the graph or a file is unreadable', () => {
    for (const legs of [
      pr(null),
      pr([mutant('crates/core/lonely/src/lib.rs')], true, null),
      pr([mutant('crates/core/lonely/src/lib.rs')], true, []),
      pr([mutant('crates/elsewhere/src/lib.rs')]),
      pr(['not a mutant line']),
    ]) {
      expect(legs).toHaveLength(FULL_SET)
      expect(legs.every((l) => l.packages === '' && l.tests === '')).toBe(true)
    }
  })

  it('plans a push to main as it plans a pull request, judged by every crate that can observe it', () => {
    // A push judged by the whole workspace runs every test per mutant, and on
    // main that took past the 120 s timeout for mutants their own crate's
    // tests catch at once.
    const diff = [
      ...mutantsIn('crates/core/edge/src/route.rs', 3),
      mutant('crates/core/lonely/src/lib.rs'),
    ]
    const push = shardPlan({ event: 'push', scopeRuns: true, mutants: diff, members })
    expect(push).toEqual(pr(diff))
    expect(push.map((l) => [l.packages, l.tests])).toEqual([
      ['edge', 'edge wasm'],
      ['lonely', 'lonely'],
    ])
    expect(shardPlan({ event: 'push', scopeRuns: true, mutants: [], members })).toEqual([])
    expect(shardPlan({ event: 'push', scopeRuns: true, mutants: null, members })).toHaveLength(
      FULL_SET,
    )
    expect(
      shardPlan({ event: 'push', scopeRuns: true, mutants: diff, members: null }),
    ).toHaveLength(FULL_SET)
  })

  it.each([
    'schedule',
    'merge_group',
    'workflow_dispatch',
  ])('keeps the whole workspace in eight legs on %s, whatever the diff holds', (event) => {
    const legs = shardPlan({ event, scopeRuns: false, mutants: [], members })
    expect(legs).toHaveLength(FULL_SET)
    expect(legs.every((l) => l.packages === '' && l.tests === '')).toBe(true)
    expect(legs.map((l) => l.shard)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((k) => `${k}/8`))
  })

  it("reads a leg's package lists and refuses what is not a package name", () => {
    expect(packageList(undefined)).toEqual([])
    expect(packageList('a-b  c_d')).toEqual(['a-b', 'c_d'])
    expect(packageList('a; rm -rf /')).toBeInstanceOf(Error)
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
