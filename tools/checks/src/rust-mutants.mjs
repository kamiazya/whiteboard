#!/usr/bin/env node
// `pnpm rust:mutants:pr` / `pnpm rust:mutants:full`: cargo-mutants over the
// Rust workspace (QR-17).
//
//   pr    the mutants in the lines this change touches under crates/, against
//         RUST_MUTANTS_BASE (default origin/main): `cargo mutants --in-diff`,
//         less the files `.cargo/mutants-pr-exclude.txt` lists, which are too
//         many to judge in a shard and are passed as `--exclude` here, in this
//         mode alone (the config's `exclude_globs` would apply to both).
//   full  every mutant in the workspace, those files included. Run by hand:
//         CI judges a push to main in-diff too, until the workspace's
//         survivors are classified.
//
//   plan  the legs the CI job fans out to (ci.yml's `rust-mutants-plan`): the
//         mutants `pr` would judge are LISTED, not run, grouped by the tests
//         that can observe them, and each group sharded by its own size.
//         Reads EVENT and SCOPE_RUNS, writes `shards` (a JSON array of legs,
//         empty when none is owed) and `total` to $GITHUB_OUTPUT. See
//         shardPlan for what is narrowed and what fails closed.
//   baseline  `cargo test --locked` over the tests a leg judges by, which CI
//         runs green before the leg's mutants.
//
// A leg is judged by its tests: RUST_MUTANTS_PACKAGES are the packages whose
// mutants it runs and RUST_MUTANTS_TESTS the packages whose tests judge them
// (`--package` / `--test-package`). `plan` sets those for a pull request to a
// mutated package and its transitive reverse dependents, dev-dependencies
// included, since a test in any other crate cannot call the mutated code; so
// the edge crate is still judged by the wasm crate's replay of the TypeScript's
// recorded answers, and a crate nothing depends on is judged by its own tests
// alone. A push to main is planned the same way. Unset, both are the whole
// workspace (`--workspace`, `--test-workspace=true`), which is what `full`, a
// merge queue, a schedule and a plan that could not be read run. The baseline
// is skipped because the job runs the same tests green in a step of its own
// first; a failing baseline
// would otherwise read as every mutant caught. `--shard k/n`
// (RUST_MUTANTS_SHARD) splits the list with identical arguments on every leg
// of a group, dealt round-robin: the list is sorted by file, and a slice puts
// every mutant of a crate low in the graph (det, plugin-visual, whose mutants
// rebuild most of the workspace) on one leg, which then outlives the job's
// timeout while the others finish early.
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
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cargoShard,
  IN_DIFF_EVENTS,
  ledgerEntries,
  ledgerProblems,
  mutantNames,
  packageList,
  prExcludeGlobs,
  prExcludeProblems,
  shardPlan,
  workspaceMembers,
} from './rust-mutants-ledger.mjs'

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
if (mode !== 'pr' && mode !== 'full' && mode !== 'plan' && mode !== 'baseline')
  fail('usage: rust-mutants.mjs pr|full|plan|baseline')

// What a CI leg judges and by which tests (shardPlan's `packages` and `tests`);
// both unset is the whole workspace on both sides.
const legPackages = packageList(process.env.RUST_MUTANTS_PACKAGES)
const legTests = packageList(process.env.RUST_MUTANTS_TESTS)
if (legPackages instanceof Error) fail(`RUST_MUTANTS_PACKAGES: ${legPackages.message}`)
if (legTests instanceof Error) fail(`RUST_MUTANTS_TESTS: ${legTests.message}`)

if (mode === 'baseline') {
  // The tests every mutant of this leg is judged by, green before any mutant
  // is: a red tree would otherwise read as every mutant caught.
  const testArgs = legTests.length > 0 ? legTests.flatMap((p) => ['-p', p]) : ['--workspace']
  const baseline = spawnSync('cargo', ['test', '--locked', ...testArgs], { stdio: 'inherit' })
  process.exit(baseline.status ?? 1)
}

/**
 * The mutants `pr` would judge, by listing them with the filters `pr`
 * applies. Nothing is built: cargo-mutants parses the sources. `null` is
 * "could not tell" and plans the full set.
 * @returns {string[] | null}
 */
function inDiffMutants() {
  const excluded = prExcludeGlobs(readFileSync('.cargo/mutants-pr-exclude.txt', 'utf8'))
  const base = process.env.RUST_MUTANTS_BASE ?? 'origin/main'
  const diff = spawnSync('git', ['diff', '--unified=0', base, '--', ':(glob)crates/**/*.rs'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (diff.status !== 0) return null
  if (diff.stdout.trim() === '') return []
  const found = spawnSync('cargo', ['mutants', '--version'], { encoding: 'utf8' })
  if (found.status !== 0 || !(found.stdout ?? '').trim().endsWith(VERSION)) return null
  const file = join(mkdtempSync(join(tmpdir(), 'rust-mutants-')), 'change.diff')
  writeFileSync(file, diff.stdout)
  const listed = spawnSync(
    'cargo',
    [
      'mutants',
      '--workspace',
      '--list',
      '--colors',
      'never',
      ...excluded.flatMap((glob) => ['--exclude', glob]),
      '--in-diff',
      file,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return listed.status === 0 ? mutantNames(listed.stdout) : null
}

/**
 * The workspace's members and their dependencies, which decide the tests that
 * can observe a mutant. `null` is "could not tell" and plans the full set.
 * @returns {ReturnType<typeof workspaceMembers> | null}
 */
function members() {
  const meta = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--locked'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return meta.status === 0 ? workspaceMembers(JSON.parse(meta.stdout)) : null
}

if (mode === 'plan') {
  const event = process.env.EVENT ?? ''
  // Anything but a stated `false` runs: an unreadable scope must not plan zero legs.
  const scopeRuns = process.env.SCOPE_RUNS !== 'false'
  let mutants = null
  let graph = null
  const inDiff = IN_DIFF_EVENTS.includes(event) && scopeRuns
  if (inDiff) {
    try {
      mutants = inDiffMutants()
      graph = mutants === null || mutants.length === 0 ? null : members()
    } catch {
      mutants = null
    }
  }
  const shards = shardPlan({ event, scopeRuns, mutants, members: graph })
  const lines = [`shards=${JSON.stringify(shards)}`, `total=${shards.length}`]
  process.stderr.write(
    `rust:mutants plan: ${mutants?.length ?? 'unknown'} mutants -> ${shards.map((l) => `[${l.leg}: ${l.packages || 'workspace'} / ${l.tests || 'workspace'}]`).join(' ')} (${lines[1]})\n`,
  )
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  // A pull request or push planned no leg still owes the ledger check the legs
  // would have run first: a change to .cargo/mutants.toml alone, or one that
  // only deletes Rust, lists no mutant, and a stale entry would otherwise
  // surface on the next full run instead of here.
  if (inDiff && shards.length === 0) checkLedger()
  process.exit(0)
}

checkLedger()

const args = [
  'mutants',
  ...(legPackages.length > 0 ? legPackages.flatMap((p) => ['--package', p]) : ['--workspace']),
  ...(legTests.length > 0
    ? legTests.flatMap((p) => ['--test-package', p])
    : ['--test-workspace=true']),
  '--baseline=skip',
  '--timeout',
  TIMEOUT_SECONDS,
  '--no-shuffle',
]
const shard = cargoShard(process.env.RUST_MUTANTS_SHARD)
if (shard instanceof Error) fail(shard.message)
if (shard !== undefined) args.push('--shard', shard, '--sharding', 'round-robin')

if (mode === 'pr') {
  const excluded = prExcludeGlobs(readFileSync('.cargo/mutants-pr-exclude.txt', 'utf8'))
  const excludeProblems = prExcludeProblems(excluded, existsSync)
  if (excludeProblems.length > 0)
    fail(`.cargo/mutants-pr-exclude.txt:\n  ${excludeProblems.join('\n  ')}`)
  for (const glob of excluded) args.push('--exclude', glob)
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

/**
 * Every `.cargo/mutants.toml` entry still names a mutant the workspace lists,
 * at the pinned cargo-mutants version. Fails the run otherwise.
 */
function checkLedger() {
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
}
