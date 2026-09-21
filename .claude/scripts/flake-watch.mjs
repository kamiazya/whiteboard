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
// id under tmp/flake-watch/ — a session start re-fetches only runs it has
// not seen.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clusterFailures, formatReport } from './flake-watch-lib.mjs'

const QUIET = process.argv.includes('--quiet')
const daysArg = process.argv.indexOf('--days')
const WINDOW_DAYS = daysArg === -1 ? 14 : Number(process.argv[daysArg + 1] ?? 14)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const CACHE_DIR = join(ROOT, 'tmp', 'flake-watch')

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf-8', timeout: 30_000 }))
}

function cached(runId, fetch) {
  const file = join(CACHE_DIR, `${runId}.json`)
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    const value = fetch()
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify(value))
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
    const commits = git(['log', base, '--format=%cI\t%s', '--', ...files])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([committedAt]) => committedAt > sinceIso)
    if (commits.length === 0) return { state: 'unchanged' }
    return { state: 'changed', commits: commits.length, newest: commits[0][1] }
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
    titles: cached(String(run.databaseId), () => {
      const jobs = gh(['api', `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs`, '--jq', '[.jobs[] | select(.conclusion=="failure") | .id]'])
      const titles = []
      for (const jobId of jobs) {
        // A job IS a check run, so its annotations live at the same id.
        for (const annotation of gh(['api', `repos/{owner}/{repo}/check-runs/${jobId}/annotations`])) {
          if (annotation.title) titles.push(annotation.title)
        }
      }
      return titles
    }),
  }))

  const report = formatReport(clusterFailures(window), WINDOW_DAYS, gitInspector())
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
