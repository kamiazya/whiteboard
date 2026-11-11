#!/usr/bin/env node
// `pnpm rust:mutants:pr` / `pnpm rust:mutants:full`: cargo-mutants over the
// Rust workspace (QR-17).
//
//   pr    the mutants in the lines this change touches under crates/, against
//         RUST_MUTANTS_BASE (default origin/main): `cargo mutants --in-diff`.
//   full  every mutant in the workspace. Run by hand: CI judges a push to
//         main in-diff too, until the workspace's survivors are classified.
//
// Both judge each mutant by the whole workspace's tests
// (`--test-workspace=true`), so the edge crate is judged by the wasm crate's
// replay of the TypeScript's recorded answers as well as its own tests. The
// baseline is skipped because the job runs `cargo test --workspace` green in
// a step of its own first; a failing baseline would otherwise read as every
// mutant caught. `--shard k/n` (RUST_MUTANTS_SHARD) splits the list with
// identical arguments on every leg, dealt round-robin: the list is sorted by
// file, and a slice puts every mutant of a crate low in the graph (det,
// plugin-visual, whose mutants rebuild most of the workspace) on one leg,
// which then outlives the job's timeout while the others finish early.
//
// cargo-mutants' exit codes are decisions, not noise (QR-17): 0 every mutant
// caught (or none in the diff), 2 one missed, 3 one timed out, 4 the baseline
// failed. This fails on every one but 0. A mutant that is equivalent, or that
// follows a permissive contract, is ledgered instead: `#[mutants::skip]` with
// a reason on the same item, or an `exclude_re` entry in .cargo/mutants.toml
// with its reason in a comment above it.
//
// The version is pinned; a different one fails naming the install command,
// because a newer cargo-mutants generates different mutants and the gate
// would judge a diff by a list nobody reviewed.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cargoShard, ledgerEntries, ledgerProblems, mutantNames } from './rust-mutants-ledger.mjs'

const VERSION = '27.1.0'
const INSTALL = `cargo install --locked cargo-mutants --version ${VERSION}`
const TIMEOUT_SECONDS = '120'

const MEANING = {
  2: 'a mutant was MISSED: a test that would have caught it is owed, or a ledger entry with its reason',
  3: 'a mutant TIMED OUT: a change that loops is a defect the tests did not name; ledger it with its measured duration only if the loop is the mutant, not the code',
  4: 'the unmutated baseline FAILED: the tests are red without any mutant, so nothing was judged',
}

function fail(message) {
  process.stderr.write(`rust:mutants: ${message}\n`)
  process.exit(1)
}

const mode = process.argv[2]
if (mode !== 'pr' && mode !== 'full') fail('usage: rust-mutants.mjs pr|full')

const version = spawnSync('cargo', ['mutants', '--version'], { encoding: 'utf8' })
const found = (version.stdout ?? '').trim()
if (version.status !== 0) fail(`cargo-mutants is not installed. Install it with:\n  ${INSTALL}`)
if (!found.endsWith(VERSION))
  fail(`cargo-mutants ${VERSION} is required, found \`${found}\`:\n  ${INSTALL}`)

// `--colors never`: CI sets CARGO_TERM_COLOR=always, and coloured names
// (`replace \x1b[38;5;13mmeasure\x1b[0m ->`) match no ledger pattern, which
// reads as every entry being stale.
const listed = spawnSync(
  'cargo',
  ['mutants', '--workspace', '--list', '--no-config', '--colors', 'never'],
  {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
)
if (listed.status !== 0) fail(`cargo mutants --list failed:\n${listed.stderr}`)
const problems = ledgerProblems(
  ledgerEntries(readFileSync('.cargo/mutants.toml', 'utf8')),
  mutantNames(listed.stdout),
)
if (problems.length > 0) fail(`the mutants ledger:\n  ${problems.join('\n  ')}`)

const args = [
  'mutants',
  '--workspace',
  '--test-workspace=true',
  '--baseline=skip',
  '--timeout',
  TIMEOUT_SECONDS,
  '--no-shuffle',
]
const shard = cargoShard(process.env.RUST_MUTANTS_SHARD)
if (shard instanceof Error) fail(shard.message)
if (shard !== undefined) args.push('--shard', shard, '--sharding', 'round-robin')

if (mode === 'pr') {
  const base = process.env.RUST_MUTANTS_BASE ?? 'origin/main'
  const diff = spawnSync('git', ['diff', '--unified=0', base, '--', ':(glob)crates/**/*.rs'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  // Fail closed: a diff that cannot be taken is not a diff with no mutants.
  if (diff.status !== 0) fail(`git diff against ${base} failed:\n${diff.stderr}`)
  if (diff.stdout.trim() === '') {
    process.stdout.write('rust:mutants: no Rust source changed, so no mutant is in the diff\n')
    process.exit(0)
  }
  const file = join(mkdtempSync(join(tmpdir(), 'rust-mutants-')), 'change.diff')
  writeFileSync(file, diff.stdout)
  args.push('--in-diff', file)
}

process.stdout.write(`\n$ cargo ${args.join(' ')}\n`)
const run = spawnSync('cargo', args, { stdio: 'inherit' })
const status = run.status ?? 1
if (status === 0) process.exit(0)
fail(`cargo mutants exited ${status}: ${MEANING[status] ?? 'it did not run to an answer'}`)
