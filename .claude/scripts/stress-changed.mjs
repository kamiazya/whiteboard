#!/usr/bin/env node
// The local counterpart of CI's `stress-changed-tests` job: re-run every test file this branch
// touched the way the job does, so a repeat-sensitive test is red here instead of on the PR.
//
//   node .claude/scripts/stress-changed.mjs [--base=<ref>] [--only=node|browser] [--committed-only] [--dry-run]
//
// For each of the job's two legs (the browser projects, then everything else) it runs the changed
// files FRESH_RUNS times, one vitest process each, and then once more with `--repeats=REPEATS` in a
// single process: the first resets module state, order and env between runs, the second is what
// catches state a test leaves behind for its own next repetition. Stops at the first failure and
// exits 1, as the job's `bash -e` loop does.
//
// The file list is `git diff --name-only <base>...HEAD` over CHANGED_TEST_PATHSPEC, plus the
// working tree's own changes (`git diff --name-only HEAD` and `git ls-files --others
// --exclude-standard`) because red-first work leaves its tests uncommitted and a committed-only
// list would answer "nothing to stress" about exactly them; `--committed-only` is the job's view.
// Each file is printed with where it came from. The commands are the job's own minus its `--shard`. `tools/arch-lint/src/stress-changed-parity.test.ts`
// reads ci.yml and fails when any of those drift. `--dry-run` prints that plan (`plan ...` lines)
// without running anything; the base is not fetched, so `origin/main` is whatever was last fetched.
//
// `--only=` runs one leg: the browser leg needs Chrome.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseScriptArgs } from './script-flags.mjs'

const FRESH_RUNS = 5
const REPEATS = 3
// `.claude/**` is excluded because its test-NAMED files (biome-plugin lint fixtures) belong to no
// vitest project, and vitest exits 1 on a file list that matches no project.
const CHANGED_TEST_PATHSPEC = [
  '*.test.ts',
  '*.test.tsx',
  '*.browser.test.ts',
  '*.browser.test.tsx',
  ':(exclude).claude/**',
]
// Partitioned by project NAME, as the job is: every browser project's name ends `-browser`.
const LEGS = [
  { name: 'browser', project: '*-browser' },
  { name: 'node', project: '!*-browser' },
]
const FILES_PLACEHOLDER = '<files>'
const USAGE = [
  'usage: stress-changed.mjs [--base=<ref>] [--only=node|browser] [--committed-only] [--dry-run]',
  `  re-runs the test files changed against <ref> (default origin/main, not fetched) and in the working`,
  `  tree (modified or untracked): ${FRESH_RUNS} fresh processes, then one with --repeats=${REPEATS}, per leg -`,
  "  the same as CI's stress-changed-tests job. --committed-only drops the working tree's files.",
  '  --dry-run prints the plan and runs nothing.',
].join('\n')

const shellQuote = (token) =>
  token === FILES_PLACEHOLDER || /^[A-Za-z0-9_./=:@%+-]+$/.test(token)
    ? token
    : `'${token.replaceAll("'", "'\\''")}'`
const commandLine = (words) => words.map(shellQuote).join(' ')

const vitestArgs = (project, { repeats }, files) => [
  'exec',
  'vitest',
  'run',
  '--project',
  project,
  ...(repeats ? [`--repeats=${REPEATS}`] : []),
  '--fsModuleCache',
  '--passWithNoTests',
  ...files,
]

function refuse(reason) {
  process.stderr.write(`${reason}\n${USAGE}\n`)
  process.exit(2)
}

function parseInvocation() {
  const options = {}
  const rest = []
  for (const arg of process.argv.slice(2)) {
    const valued = /^--(base|only)=(.*)$/.exec(arg)
    if (valued) options[valued[1]] = valued[2]
    else rest.push(arg)
  }
  const { flags } = parseScriptArgs({
    argv: rest,
    flags: ['--dry-run', '--committed-only'],
    usage: USAGE,
  })
  const base = options.base ?? 'origin/main'
  if (base === '') refuse('--base needs a ref')
  if (options.only !== undefined && !LEGS.some((leg) => leg.name === options.only)) {
    refuse(`--only must be one of ${LEGS.map((leg) => leg.name).join(', ')}`)
  }
  const legs = LEGS.filter((leg) => options.only === undefined || leg.name === options.only)
  return { base, legs, flags }
}

const diffArgsAgainst = (base) => [
  'diff',
  '--name-only',
  `${base}...HEAD`,
  '--',
  ...CHANGED_TEST_PATHSPEC,
]
const WORKING_TREE_ARGS = [
  ['diff', '--name-only', 'HEAD', '--', ...CHANGED_TEST_PATHSPEC],
  ['ls-files', '--others', '--exclude-standard', '--', ...CHANGED_TEST_PATHSPEC],
]

const listGit = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\n')

function failListing(what, error) {
  process.stderr.write(`${what}: ${String(error.stderr ?? error.message).trim()}\n`)
  process.exit(1)
}

/** Changed test files (that still exist) mapped to where each came from. */
function collectChangedFiles(root, base, committedOnly) {
  const sources = new Map()
  const note = (file, source) => {
    if (file !== '') sources.set(file, [...(sources.get(file) ?? []), source])
  }
  try {
    for (const file of listGit(root, diffArgsAgainst(base))) note(file, 'committed')
  } catch (error) {
    // An unresolvable base is an error, never "no files changed": an empty list stresses nothing
    // and reads as success.
    failListing(`cannot list changed test files against ${base}`, error)
  }
  if (!committedOnly) {
    try {
      for (const file of listGit(root, WORKING_TREE_ARGS[0])) note(file, 'modified')
      for (const file of listGit(root, WORKING_TREE_ARGS[1])) note(file, 'untracked')
    } catch (error) {
      failListing('cannot list working-tree test files', error)
    }
  }
  // A file the diff DELETED has nothing to run.
  const files = [...sources.keys()].filter((file) => existsSync(join(root, file))).sort()
  return { files, sources }
}

function printPlan({ base, legs, committedOnly, files, sources }) {
  console.log(`plan base: ${base}`)
  console.log(`plan collect: ${commandLine(['git', ...diffArgsAgainst(base)])}`)
  if (!committedOnly)
    for (const args of WORKING_TREE_ARGS)
      console.log(`plan collect: ${commandLine(['git', ...args])}`)
  console.log(`plan files: ${files.length}`)
  for (const file of files) console.log(`plan file: ${file} (${sources.get(file).join(', ')})`)
  console.log(`plan fresh-runs: ${FRESH_RUNS}`)
  for (const leg of legs) {
    console.log(
      `plan ${leg.name} fresh: ${commandLine(['pnpm', ...vitestArgs(leg.project, { repeats: false }, [FILES_PLACEHOLDER])])}`,
    )
    console.log(
      `plan ${leg.name} repeats: ${commandLine(['pnpm', ...vitestArgs(leg.project, { repeats: true }, [FILES_PLACEHOLDER])])}`,
    )
  }
}

function runStress(root, legs, files) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const run = (label, args) => {
    console.log(`=== ${label} ===`)
    const result = spawnSync(pnpm, args, { cwd: root, stdio: 'inherit' })
    if (result.status !== 0) {
      console.error(
        `stress-changed: FAILED at ${label}${result.error ? ` (${result.error.message})` : ''}`,
      )
      process.exit(1)
    }
  }
  for (const leg of legs) {
    for (let i = 1; i <= FRESH_RUNS; i++) {
      run(
        `stress run ${i}/${FRESH_RUNS} (${leg.name})`,
        vitestArgs(leg.project, { repeats: false }, files),
      )
    }
    run(
      `in-process repeats x${REPEATS} (${leg.name})`,
      vitestArgs(leg.project, { repeats: true }, files),
    )
  }
}

function main() {
  const { base, legs, flags } = parseInvocation()
  const committedOnly = flags.has('--committed-only')
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()
  const { files, sources } = collectChangedFiles(root, base, committedOnly)
  printPlan({ base, legs, committedOnly, files, sources })
  if (flags.has('--dry-run')) return
  if (files.length === 0) {
    console.log(
      `no changed test files against ${base}${committedOnly ? '' : ' or in the working tree'} - nothing to stress`,
    )
    return
  }
  runStress(root, legs, files)
  console.log('stress-changed: all runs passed')
}

main()
