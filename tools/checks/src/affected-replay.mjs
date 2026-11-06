#!/usr/bin/env node

// @whiteboard/checks — what change-scoped CI would have saved, replayed over
// main's history.
//
// Each first-parent commit of main is one squash-merged pull request, so its
// diff against its parent is that pull request's change. This replays
// affected.mjs over each one and prices the plan with a per-job timing
// profile measured off real pull-request runs, against the same run with
// every job doing its full work — which is what ci.yml does today.
//
//   node tools/checks/src/affected-replay.mjs [--count 50] [--ref origin/main] [--json]
//   node tools/checks/src/affected-replay.mjs profile [--runs 20] > profile.json
//   node tools/checks/src/affected-replay.mjs --profile profile.json
//
// What the estimate does NOT model, so the numbers are read correctly:
//
//   - The graph and the docs-reader scan are today's tree, not each commit's.
//   - A job that runs a PART of its projects is priced at its full runtime,
//     so the saving inside a job is not counted: an under-estimate.
//   - Each leg keeps the start offset it was measured at (runner pickup). A
//     skipped leg costs its pickup plus SKIPPED_LEG_SECONDS.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseNameStatus, planScope, readRepoInputs } from './affected.mjs'
import {
  affectsDockerBuild,
  dockerBuildTargets,
  indexManifests,
  workspaceClosure,
} from './docker-build-inputs.mjs'
import { isRunAsScript } from './is-run-as-script.mjs'
import { readProjectTestGlobs, testGlobMatches } from './vitest-projects.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Median start offset (seconds after the run started) and median runtime of
 * every leg, over the 20 most recent first-attempt successful pull-request
 * runs of ci.yml read on 2026-11-06 (runs 39741871033..42179679168). Their
 * median wall to the last job before ci-gate was 490s. Regenerate with the
 * `profile` command.
 */
export const MEASURED_PROFILE = {
  check: [64, 131],
  'dry-run-docker': [72, 209],
  'extension-smokes': [78, 166],
  'native-host-windows': [36, 69],
  'packaged-smoke': [67, 187],
  'sbom-npm': [51, 82],
  'stress-changed-tests (browser)': [85, 268],
  'stress-changed-tests (node 1)': [82, 135],
  'stress-changed-tests (node 2)': [88, 148],
  'stress-changed-tests (node 3)': [86, 154],
  'test-browser (1)': [81, 356],
  'test-browser (2)': [66, 302],
  'test-jsdom (1)': [66, 354],
  'test-jsdom (2)': [56, 332],
  'test-shared (1)': [67, 274],
  'test-shared (2)': [75, 284],
  'test-unit (1)': [67, 274],
  'test-unit (2)': [82, 251],
  verify: [97, 242],
  'widget-smoke': [65, 64],
}

/**
 * A leg that skips its work: set-up, checkout and the runner's closing step
 * measured at a median of 4s (max 9s) on the same runs, plus the detection.
 */
const SKIPPED_LEG_SECONDS = 10

/**
 * The stress lane installs before it knows whether any test changed (setup
 * plus install measured at a median 45s), so its no-file case is not free.
 */
const STRESS_NO_FILES_SECONDS = 55

/** @param {string} leg */
const jobOf = (leg) => leg.replace(/ \(.*$/, '')

const TEST_FILE = /\.test\.tsx?$/

/**
 * @param {{ path: string, status: string }[]} changes
 * @param {string} leg
 */
function stressLegHasWork(changes, leg) {
  const tests = changes.filter(
    ({ path, status }) => status !== 'D' && TEST_FILE.test(path) && !path.startsWith('.claude/'),
  )
  const browser = tests.some(({ path }) => /\.browser\.test\./.test(path))
  return leg.includes('browser')
    ? browser
    : tests.some(({ path }) => !/\.browser\.test\./.test(path))
}

/**
 * What a project job costs whatever it runs: set-up, checkout and install,
 * measured at a median 49s on the same runs. The rest of its runtime is
 * scaled by the share of its test FILES the plan selects in the proportional
 * estimate — files are not cost, so that number is a guide, not a measurement.
 */
const JOB_FIXED_SECONDS = 49

/**
 * @typedef {{
 *   changes: { path: string, status: string }[],
 *   plan: { jobs: Record<string, { run: boolean }> } | null,
 *   docker: boolean,
 *   profile: Record<string, [number, number]>,
 *   shares?: Record<string, number>,
 * }} PriceInput  `plan: null` prices today's workflow, where every scoped job
 *   runs; `shares` (job -> selected fraction of its test files) turns on the
 *   proportional estimate
 */

/** @param {PriceInput} input @param {string} leg @param {number} runtime */
function legSeconds({ changes, plan, docker, shares }, leg, runtime) {
  const job = jobOf(leg)
  if (job === 'stress-changed-tests') {
    return stressLegHasWork(changes, leg) ? runtime : STRESS_NO_FILES_SECONDS
  }
  if (job === 'dry-run-docker') return docker ? runtime : SKIPPED_LEG_SECONDS
  const planned = plan?.jobs[job]
  if (!planned) return runtime
  if (!planned.run) return SKIPPED_LEG_SECONDS
  const share = shares?.[job]
  if (share === undefined) return runtime
  return Math.round(JOB_FIXED_SECONDS + Math.max(0, runtime - JOB_FIXED_SECONDS) * share)
}

/** @param {PriceInput} input */
export function priceRun(input) {
  let wall = 0
  let runnerSeconds = 0
  for (const [leg, [start, runtime]] of Object.entries(input.profile)) {
    const seconds = legSeconds(input, leg, runtime)
    wall = Math.max(wall, start + seconds)
    runnerSeconds += seconds
  }
  return { wall, runnerSeconds }
}

/**
 * Test files per root vitest project, read with the configs' own globs.
 * @param {string[]} trackedFiles
 */
function testFilesPerProject(trackedFiles) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const project of readProjectTestGlobs(REPO_ROOT)) {
    if (!project.name) continue
    const inDir = trackedFiles
      .filter((file) => file.startsWith(`${project.dir}/`))
      .map((file) => file.slice(project.dir.length + 1))
    counts[project.name] = inDir.filter(
      (rel) =>
        project.include.some((glob) => testGlobMatches(glob, rel)) &&
        !project.exclude.some((glob) => testGlobMatches(glob, rel)),
    ).length
  }
  return counts
}

/**
 * @param {Record<string, { projects: string[] | null }>} jobs
 * @param {{ name: string, job: string }[]} projects
 * @param {Record<string, number>} files
 */
function selectedShares(jobs, projects, files) {
  /** @type {Record<string, number>} */
  const shares = {}
  for (const [job, { projects: picked }] of Object.entries(jobs)) {
    if (!picked) continue
    const universe = projects.filter((p) => p.job === job).map((p) => p.name)
    const total = universe.reduce((sum, name) => sum + (files[name] ?? 0), 0)
    const chosen = picked.reduce((sum, name) => sum + (files[name] ?? 0), 0)
    if (total > 0) shares[job] = chosen / total
  }
  return shares
}

/** @param {string} ref @param {number} count */
function firstParentCommits(ref, count) {
  return execFileSync('git', ['log', '--first-parent', '--format=%H%x09%s', `-${count}`, ref], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split('\t')
      return { sha, subject: subject.join('\t') }
    })
}

/** @param {string[]} argv */
function option(argv, name, fallback) {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}

/** @param {number[]} values */
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
}

function replay(argv) {
  const count = Number(option(argv, '--count', '50'))
  const ref = option(argv, '--ref', 'origin/main')
  const profilePath = option(argv, '--profile', null)
  const profile = profilePath ? JSON.parse(readFileSync(profilePath, 'utf8')) : MEASURED_PROFILE
  const inputs = readRepoInputs(REPO_ROOT)
  const manifests = execFileSync('git', ['ls-files', 'package.json', '*/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((p) => p.length > 0 && !p.includes('node_modules/'))
  const dockerClosure = workspaceClosure(
    dockerBuildTargets(readFileSync(join(REPO_ROOT, 'Dockerfile.server'), 'utf8')),
    indexManifests(REPO_ROOT, manifests),
  )

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const files = testFilesPerProject(tracked)

  /** @param {{ path: string, status: string }[]} changes */
  const price = (changes) => {
    const plan = planScope({ changes, event: 'pull_request', ...inputs })
    const docker = affectsDockerBuild(
      changes.map((c) => c.path),
      dockerClosure,
    )
    const today = priceRun({ changes, plan: null, docker, profile })
    const scoped = priceRun({ changes, plan, docker, profile })
    const shares = selectedShares(plan.jobs, inputs.projects, files)
    const proportional = priceRun({ changes, plan, docker, profile, shares })
    return {
      everything: plan.everything,
      why: plan.everything ? plan.reasons[0] : plan.reasons.join('; '),
      skippedJobs: Object.entries(plan.jobs)
        .filter(([, job]) => !job.run)
        .map(([id]) => id),
      projects: `${plan.projects.length}/${inputs.projects.length}`,
      wallToday: today.wall,
      wallScoped: scoped.wall,
      wallProportional: proportional.wall,
      runnerToday: today.runnerSeconds,
      runnerScoped: scoped.runnerSeconds,
      runnerProportional: proportional.runnerSeconds,
    }
  }

  const rows = []
  for (const { sha, subject } of firstParentCommits(ref, count)) {
    let changes
    try {
      changes = parseNameStatus(
        execFileSync('git', ['diff', '--name-status', '--no-renames', `${sha}^1`, sha], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }),
      )
    } catch {
      continue // the parent is outside a shallow clone
    }
    rows.push({
      sha: sha.slice(0, 8),
      subject: subject.slice(0, 60),
      files: changes.length,
      ...price(changes),
    })
  }
  // A one-file change inside each node alone: what a pull request scoped to
  // that package would save. History says how often such a PR happens; this
  // says what each one is worth when it does.
  const scenarios = inputs.nodes.map((n) => ({
    node: n.id,
    ...price([{ path: `${n.dir}/src/index.ts`, status: 'M' }]),
  }))
  return { rows, scenarios, profile }
}

/** @param {{ wallToday: number, wallScoped: number, wallProportional: number, runnerToday: number, runnerScoped: number, runnerProportional: number }} r */
const timing = (r) =>
  `wall ${r.wallToday}s->${r.wallScoped}s (~${r.wallProportional}s) ` +
  `runner ${r.runnerToday}s->${r.runnerScoped}s (~${r.runnerProportional}s)`

/** @param {number[]} values */
const sum = (values) => values.reduce((a, b) => a + b, 0)

/** @param {string} label @param {number[]} saved @param {number} total */
const savingLine = (label, saved, total) =>
  `${label}: median ${median(saved)}s, mean ${Math.round(sum(saved) / Math.max(saved.length, 1))}s, ` +
  `max ${Math.max(0, ...saved)}s, total ${sum(saved)}s of ${total}s; PRs saving any: ${saved.filter((s) => s > 0).length}`

function printReport(rows, scenarios) {
  const lines = rows.map(
    (r) =>
      `${r.sha} ${String(r.files).padStart(4)}f ${r.everything ? 'ALL ' : 'SCOP'} ` +
      `proj ${r.projects.padStart(5)} ${timing(r)} skip[${r.skippedJobs.join(',')}] ${r.subject}`,
  )
  const narrowed = rows.filter((r) => !r.everything)
  const wallToday = sum(rows.map((r) => r.wallToday))
  const runnerToday = sum(rows.map((r) => r.runnerToday))
  const everythingWhy = new Map()
  for (const r of rows.filter((row) => row.everything)) {
    const key = r.why.replace(/^[^:]*: /, '')
    everythingWhy.set(key, (everythingWhy.get(key) ?? 0) + 1)
  }
  return [
    ...lines,
    '',
    `pull requests replayed: ${rows.length}`,
    `selected everything: ${rows.length - narrowed.length}; narrowed: ${narrowed.length}`,
    'full-job pricing (a job that runs any project costs its whole measured runtime):',
    `  ${savingLine(
      'wall saved',
      rows.map((r) => r.wallToday - r.wallScoped),
      wallToday,
    )}`,
    `  ${savingLine(
      'runner saved',
      rows.map((r) => r.runnerToday - r.runnerScoped),
      runnerToday,
    )}`,
    'proportional estimate (~, a job costs its fixed set-up plus its selected share of test files):',
    `  ${savingLine(
      'wall saved',
      rows.map((r) => r.wallToday - r.wallProportional),
      wallToday,
    )}`,
    `  ${savingLine(
      'runner saved',
      rows.map((r) => r.runnerToday - r.runnerProportional),
      runnerToday,
    )}`,
    'why everything (first reason per PR):',
    ...[...everythingWhy.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${n}  ${k}`),
    '',
    'a pull request touching one package alone (one source file):',
    ...scenarios.map(
      (r) =>
        `  ${r.node.padEnd(40)} ${r.everything ? 'ALL ' : 'SCOP'} proj ${r.projects.padStart(5)} ` +
        `${timing(r)} skip[${r.skippedJobs.join(',')}]`,
    ),
  ].join('\n')
}

/**
 * The timing profile, re-measured: median start offset and runtime per leg
 * over the last N first-attempt successful pull-request runs, read through
 * `gh api` (REST, which works where gh's GraphQL commands do not).
 * @param {string[]} argv
 */
function profileCommand(argv) {
  const runs = Number(option(argv, '--runs', '20'))
  const gh = (path) =>
    JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  const listed = gh(
    `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=${runs * 2}`,
  ).workflow_runs.filter((run) => run.run_attempt === 1)
  /** @type {Record<string, [number[], number[]]>} */
  const legs = {}
  for (const run of listed.slice(0, runs)) {
    const t0 = Date.parse(run.run_started_at)
    for (const job of gh(`repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs) {
      if (!job.started_at || !job.completed_at || job.name === 'ci-gate') continue
      const leg = job.name
        .replace(/^stress-changed-tests \(browser.*\)$/, 'stress-changed-tests (browser)')
        .replace(
          /^stress-changed-tests \(node, [^,]*, (\d+), \d+\)$/,
          'stress-changed-tests (node $1)',
        )
      const start = Date.parse(job.started_at)
      legs[leg] ??= [[], []]
      legs[leg][0].push(Math.round((start - t0) / 1000))
      legs[leg][1].push(Math.round((Date.parse(job.completed_at) - start) / 1000))
    }
  }
  const profile = Object.fromEntries(
    Object.entries(legs)
      .sort()
      .map(([leg, [starts, runtimes]]) => [leg, [median(starts), median(runtimes)]]),
  )
  process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`)
}

if (isRunAsScript(import.meta.url)) {
  const argv = process.argv.slice(2)
  if (argv[0] === 'profile') {
    profileCommand(argv.slice(1))
  } else {
    const { rows, scenarios } = replay(argv)
    process.stdout.write(
      argv.includes('--json')
        ? `${JSON.stringify({ rows, scenarios }, null, 2)}\n`
        : `${printReport(rows, scenarios)}\n`,
    )
  }
}
