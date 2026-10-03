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
// Annotations of a completed run never change, so they are cached per run
// id under the git common dir's flake-watch/ (shared by every worktree of the
// clone) — a session start re-fetches only runs no checkout has seen.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clusterFailures, commitsLandedAfter, failedLegFrom, flakeCacheDir, formatReport, runPassedAfter } from './flake-watch-lib.mjs'

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

function cached(runId, fetch) {
  const file = join(CACHE_DIR, `${runId}.${CACHE_SHAPE}.json`)
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    const value = fetch()
    mkdirSync(CACHE_DIR, { recursive: true })
    // Sessions in different worktrees now share the directory, so a reader
    // must never see a half-written file: write beside it and rename.
    const staging = `${file}.${process.pid}.tmp`
    writeFileSync(staging, JSON.stringify(value))
    renameSync(staging, file)
    return value
  }
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
  const git = (args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 })
  const base = (() => {
    try {
      git(['rev-parse', '--verify', '--quiet', 'origin/main'])
      return 'origin/main'
    } catch {
      return 'HEAD'
    }
  })()
  return (path, sinceIso) => {
    const files = git(['ls-files', `*${path}`]).split('\n').filter(Boolean)
    if (files.length === 0) return { state: 'missing' }
    const commits = commitsLandedAfter(git(['log', base, '--format=%cI\t%s', '--', ...files]), sinceIso)
    // A later commit whose SUBJECT names the file, touching it or not: the
    // shape a root-cause fix has, and "fixed in <sha>" is what the report
    // otherwise has no way to record.
    const name = path.split('/').pop()
    const naming = commitsLandedAfter(
      git(['log', base, '--format=%cI\t%s', '--fixed-strings', `--grep=${name}`]),
      sinceIso,
    )
    const namedBy = naming[0]?.[1]
    if (commits.length === 0) return namedBy === undefined ? { state: 'unchanged' } : { state: 'unchanged', namedBy }
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
      'run', 'list', '--branch', 'main', '--workflow', 'ci', '--status', 'success',
      '--limit', '50', '--json', 'createdAt',
    ])
    return (iso) => runPassedAfter(passed, iso)
  } catch {
    return undefined
  }
}

function main() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  const runs = gh([
    'run', 'list', '--branch', 'main', '--workflow', 'ci', '--status', 'failure',
    '--limit', '100', '--json', 'databaseId,createdAt',
  ]).filter((run) => run.createdAt >= since)

  const window = runs.map((run) => ({
    runId: String(run.databaseId),
    createdAt: run.createdAt,
    // title, path and message — the last two are what keys a failure that
    // names no test (`Unhandled error`; see `unhandledIdFrom`). A run cached
    // by an older version holds bare titles; `clusterFailures` accepts both,
    // so a cache written before this change still reads.
    annotations: cached(String(run.databaseId), () => {
      const jobs = gh(['api', `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs`, '--jq', '[.jobs[] | select(.conclusion=="failure") | .id]'])
      const annotations = []
      for (const jobId of jobs) {
        // A job IS a check run, so its annotations live at the same id.
        for (const annotation of gh(['api', `repos/{owner}/{repo}/check-runs/${jobId}/annotations`])) {
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

  const report = formatReport(clusterFailures(window), WINDOW_DAYS, gitInspector(), mainPassedAfter())
  if (report !== '') process.stdout.write(`${report}\n`)
  else if (!QUIET) {
    process.stdout.write(
      `[flake-watch] no recurring test failure on main in ${WINDOW_DAYS} days (${window.length} failed run(s) examined)\n`,
    )
  }
}

try {
  main()
} catch (error) {
  // The daemon being down never blocked stale-issues; gh being absent,
  // unauthenticated, or offline must not block this either.
  if (!QUIET) process.stderr.write(`[flake-watch] skipped: ${error.message}\n`)
}
