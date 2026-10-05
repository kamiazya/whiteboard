#!/usr/bin/env node
// Report tests that failed main CI more than once in the window — the
// watcher for integrator-flow.md's second-occurrence rule. Read-only,
// silent when there is nothing to say, and fail-open: a machine without
// `gh` or network must not make a session start red.
//
//   node .claude/scripts/flake-watch.mjs [--days 14] [--quiet]
//
// No CI-side production was added for this, measured before building:
// vitest's github-actions reporter already annotates every failure with
// `[project] file > suite > case` in the annotation title, retroactively
// readable through the check-runs API. The one hand-classified window
// (2026-08-28..09-04, sixteen failures) is pinned as the lib's fixture.
//
// It also lists, in one block, failures that are no test's and that no later
// success has retired: a `release` publish job, and the scheduled `Mutation`
// and `audit` runs — each judged against what retires it, in the lib.
//
// Annotations of a completed run never change, so they are cached per run
// id under the git common dir's flake-watch/ (shared by every worktree of the
// clone) — a session start re-fetches only runs no checkout has seen.

import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  clusterFailures,
  commitsLandedAfter,
  failedLegFrom,
  flakeCacheDir,
  formatIdleLine,
  formatReport,
  formatUnhealedReport,
  inspectPublishJobs,
  runPassedAfter,
  unhealedPublishJobs,
  unhealedWorkflowRuns,
} from './flake-watch-lib.mjs'

const QUIET = process.argv.includes('--quiet')
const daysArg = process.argv.indexOf('--days')
const WINDOW_DAYS = daysArg === -1 ? 14 : Number(process.argv[daysArg + 1] ?? 14)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

function gitCommonDir() {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim()
  } catch {
    return undefined
  }
}

const CACHE_DIR = flakeCacheDir({ gitCommonDir: gitCommonDir(), root: ROOT })

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf-8', timeout: 30_000 }))
}

// Bumped when the cached SHAPE changes, so an entry written by an older
// version is refetched rather than read as the new one. A run's annotations
// never change, so the old files simply go unread; the cache is per-machine
// and disposable, which is why this is a suffix rather than a migration.
const CACHE_SHAPE = 'v3-annotations'

function readCached(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf-8')) }
  } catch {
    return null
  }
}

function writeCached(file, value) {
  mkdirSync(CACHE_DIR, { recursive: true })
  // Sessions in different worktrees now share the directory, so a reader
  // must never see a half-written file: write beside it and rename.
  const staging = `${file}.${process.pid}.tmp`
  writeFileSync(staging, JSON.stringify(value))
  renameSync(staging, file)
}

function cached(runId, fetch, shape = CACHE_SHAPE) {
  const file = join(CACHE_DIR, `${runId}.${shape}.json`)
  const hit = readCached(file)
  if (hit !== null) return hit.value
  const value = fetch()
  writeCached(file, value)
  return value
}

async function cachedAsync(runId, fetch, shape) {
  const file = join(CACHE_DIR, `${runId}.${shape}.json`)
  const hit = readCached(file)
  if (hit !== null) return hit.value
  const value = await fetch()
  writeCached(file, value)
  return value
}

/**
 * Has the test's own file moved since that entry's newest failure? The
 * annotation title carries a PROJECT-relative path (`src/…`), so the file is
 * located with `ls-files` rather than assumed — and a path that locates
 * nothing is `missing`, which is itself an answer worth printing.
 *
 * The range is filtered on the COMMIT date (`%cI`) in JS rather than handed
 * to `--since`, for the reason `stale-issues.mjs` gives: a rebase or an
 * imported patch can leave the author date older than when the commit
 * actually landed here, and "has anything happened since it failed" is a
 * question about landing.
 */
function gitInspector() {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 })
  const base = (() => {
    try {
      git(['rev-parse', '--verify', '--quiet', 'origin/main'])
      return 'origin/main'
    } catch {
      return 'HEAD'
    }
  })()
  return (path, sinceIso) => {
    const files = git(['ls-files', `*${path}`])
      .split('\n')
      .filter(Boolean)
    if (files.length === 0) return { state: 'missing' }
    const commits = commitsLandedAfter(
      git(['log', base, '--format=%cI\t%s', '--', ...files]),
      sinceIso,
    )
    // A later commit whose SUBJECT names the file, touching it or not: the
    // shape a root-cause fix has, and "fixed in <sha>" is what the report
    // otherwise has no way to record.
    const name = path.split('/').pop()
    const naming = commitsLandedAfter(
      git(['log', base, '--format=%cI\t%s', '--fixed-strings', `--grep=${name}`]),
      sinceIso,
    )
    const namedBy = naming[0]?.[1]
    if (commits.length === 0)
      return namedBy === undefined ? { state: 'unchanged' } : { state: 'unchanged', namedBy }
    return {
      state: 'changed',
      commits: commits.length,
      newest: commits[0][1],
      newestAt: commits[0][0],
      ...(namedBy === undefined ? {} : { namedBy }),
    }
  }
}

/**
 * Whether a main CI run created after `iso` passed, from one listing of the
 * recent successful runs. `undefined` when the listing cannot be read, so the
 * report keeps what it would have shown rather than dropping on a guess.
 */
function mainPassedAfter() {
  try {
    const passed = gh([
      'run',
      'list',
      '--branch',
      'main',
      '--workflow',
      'ci',
      '--status',
      'success',
      '--limit',
      '50',
      '--json',
      'createdAt',
    ])
    return (iso) => runPassedAfter(passed, iso)
  } catch {
    return undefined
  }
}

// Workflows whose failure is no test's: a scheduled lane nobody opens, and the release. Each is
// judged by whether a later success retired it (see the lib), so the listing must reach back past
// the last success — the weekly lane is green or red once in seven days.
const SCHEDULED_WORKFLOWS = ['mutation.yml', 'audit.yml']
const SCHEDULED_LOOKBACK_DAYS = 60
const RUNS_PER_PAGE = 100
const MAX_RUN_PAGES = 10

const execFileAsync = promisify(execFile)

async function ghAsync(args) {
  const { stdout } = await execFileAsync('gh', args, { encoding: 'utf-8', timeout: 30_000 })
  return JSON.parse(stdout)
}

// Paged by hand: `gh api --paginate` follows the response's own Link header, which names the
// repository by numeric id, and a proxy that only allows `repos/{owner}/{repo}/…` refuses page 2.
// Every call here is a network round trip inside a SessionStart hook, so pages after the first
// go out together once the first one has said how many there are.
async function listRuns(workflowFile, sinceIso) {
  const page = (number) =>
    ghAsync([
      'api',
      `repos/{owner}/{repo}/actions/workflows/${workflowFile}/runs?branch=main&per_page=${RUNS_PER_PAGE}&page=${number}&created=>=${sinceIso.slice(0, 10)}`,
      '--jq',
      '{total: .total_count, runs: [.workflow_runs[] | {runId: (.id | tostring), createdAt: .created_at, conclusion, event, title: .display_title}]}',
    ])
  const first = await page(1)
  const pages = Math.min(Math.ceil(first.total / RUNS_PER_PAGE), MAX_RUN_PAGES)
  const rest = await Promise.all(
    Array.from({ length: Math.max(pages - 1, 0) }, (_, index) => page(index + 2)),
  )
  return [first, ...rest].flatMap((batch) => batch.runs)
}

/**
 * Non-vitest failures on main that no later success has retired. Its own failure never costs the
 * test report above, and a workflow it cannot read is skipped rather than guessed at.
 */
async function unhealedFailures(since) {
  const scheduledSince = new Date(Date.now() - SCHEDULED_LOOKBACK_DAYS * 86_400_000).toISOString()
  const failedWorkflows = []
  const workflows = []
  let publishJobs = []

  const scheduled = SCHEDULED_WORKFLOWS.map(async (file) => {
    try {
      const found = unhealedWorkflowRuns(await listRuns(file, scheduledSince))
      if (found !== null) workflows.push({ workflow: file.replace(/\.yml$/, ''), ...found })
    } catch {
      failedWorkflows.push(file)
    }
  })
  const release = (async () => {
    try {
      const releaseRuns = await listRuns('release.yml', since)
      const found = unhealedWorkflowRuns(releaseRuns)
      if (found !== null) workflows.push({ workflow: 'release', ...found })
      // The jobs of a completed run change only when somebody re-runs it, which also changes its
      // conclusion, so the conclusion is part of the cache key.
      const withJobs = await Promise.all(
        releaseRuns.filter(inspectPublishJobs).map(async (run) => ({
          ...run,
          jobs: await cachedAsync(
            run.runId,
            () =>
              ghAsync([
                'api',
                `repos/{owner}/{repo}/actions/runs/${run.runId}/jobs`,
                '--jq',
                '[.jobs[] | {name, conclusion}]',
              ]),
            `v1-jobs-${run.conclusion}`,
          ),
        })),
      )
      publishJobs = unhealedPublishJobs(withJobs)
    } catch {
      failedWorkflows.push('release.yml')
    }
  })()
  await Promise.all([...scheduled, release])
  workflows.sort((a, b) => a.workflow.localeCompare(b.workflow))
  return { report: formatUnhealedReport({ publishJobs, workflows }), failedWorkflows }
}

function main() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  const runs = gh([
    'run',
    'list',
    '--branch',
    'main',
    '--workflow',
    'ci',
    '--status',
    'failure',
    '--limit',
    '100',
    '--json',
    'databaseId,createdAt',
  ]).filter((run) => run.createdAt >= since)

  const window = runs.map((run) => ({
    runId: String(run.databaseId),
    createdAt: run.createdAt,
    // title, path and message — the last two are what keys a failure that
    // names no test (`Unhandled error`; see `unhandledIdFrom`). A run cached
    // by an older version holds bare titles; `clusterFailures` accepts both,
    // so a cache written before this change still reads.
    annotations: cached(String(run.databaseId), () => {
      const jobs = gh([
        'api',
        `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs`,
        '--jq',
        '[.jobs[] | select(.conclusion=="failure") | .id]',
      ])
      const annotations = []
      for (const jobId of jobs) {
        // A job IS a check run, so its annotations live at the same id.
        for (const annotation of gh([
          'api',
          `repos/{owner}/{repo}/check-runs/${jobId}/annotations`,
        ])) {
          // An EMPTY title used to mean "drop it". It does not: `ci-gate`'s
          // own summary carries the failed LEG under one
          // (`[ci-gate] test-unit (2): failure`), and that is the only thing
          // a run with no test annotation says about itself. Dropping it at
          // fetch time made the leg invisible to everything downstream —
          // found by running the real window, not by a unit test, because
          // the fixtures supply annotations the fetcher never touched.
          if (!annotation.title && failedLegFrom(annotation) === null) continue
          annotations.push({
            title: annotation.title,
            path: annotation.path,
            message: annotation.message,
          })
        }
      }
      return annotations
    }),
  }))

  const clusters = clusterFailures(window)
  const inspect = gitInspector()
  const passedAfter = mainPassedAfter()
  const report = formatReport(clusters, WINDOW_DAYS, inspect, passedAfter)
  if (report !== '') process.stdout.write(`${report}\n`)
  else if (!QUIET) {
    process.stdout.write(
      `${formatIdleLine(clusters, WINDOW_DAYS, window.length, inspect, passedAfter)}\n`,
    )
  }
}

async function reportUnhealed() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  const { report, failedWorkflows } = await unhealedFailures(since)
  if (report !== '') process.stdout.write(`${report}\n`)
  if (failedWorkflows.length > 0 && !QUIET) {
    process.stderr.write(`[flake-watch] could not read: ${failedWorkflows.join(', ')}\n`)
  }
}

// The two halves fail independently: a window the test half cannot read says nothing about the
// workflows, and the reverse.
try {
  main()
} catch (error) {
  // The daemon being down never blocked stale-issues; gh being absent,
  // unauthenticated, or offline must not block this either.
  if (!QUIET) process.stderr.write(`[flake-watch] skipped: ${error.message}\n`)
}
try {
  await reportUnhealed()
} catch (error) {
  if (!QUIET) process.stderr.write(`[flake-watch] skipped: ${error.message}\n`)
}
