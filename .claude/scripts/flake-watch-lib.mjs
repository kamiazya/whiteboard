// Which tests have failed main CI more than once — the executable half of
// integrator-flow.md's rule that a flake's SECOND occurrence promotes it to
// a root-cause fix lane. The rule had no watcher: each recurrence was
// noticed only when somebody chose to spend an afternoon classifying job
// logs by hand.
//
// The data needs no new production: vitest's github-actions reporter (on
// whenever GITHUB_ACTIONS is set) annotates every failure, and the
// annotation TITLE carries `[project] file > suite > test` — readable back
// through the check-runs API for every past run. So the identity key here
// is `[project] file`, which groups a file's tests together (a file that
// fails different cases on different days is one flake surface, not three).
//
// Pure and filesystem-free: `flake-watch.mjs` supplies the real window from
// the GitHub API; the tests replay the actual 2026-08/09 window as a
// fixture, where the expected answer is known because it was classified by
// hand first.

/**
 * `[project] path > suite > case` -> `[project] path`, or null for an
 * annotation that is not a vitest test failure (the runner's own
 * "Process completed with exit code 1." carries an empty title).
 */
export function testIdFromTitle(title) {
  const match = /^(\[[^\]]+\] \S+?\.test\.[a-z]+)(?: > |$)/.exec(title ?? '')
  return match === null ? null : match[1]
}

/**
 * @param window `{ runId, createdAt, titles }[]` — one entry per failed run,
 *   `titles` the test-failure annotation titles that run produced.
 * @returns recurrences (id seen in >= 2 DISTINCT runs, most-occurrences
 *   first, ties broken by most recent), singles, and the runs that failed
 *   with no test annotation at all — the infra-shaped family, counted
 *   rather than dropped so a registry outage does not vanish from the
 *   report entirely.
 */
export function clusterFailures(window) {
  const byId = new Map()
  const unattributedRuns = []
  for (const run of window) {
    const ids = new Set(
      run.titles.map((title) => testIdFromTitle(title)).filter((id) => id !== null),
    )
    if (ids.size === 0) {
      unattributedRuns.push({ runId: run.runId, createdAt: run.createdAt })
      continue
    }
    for (const id of ids) {
      const entry = byId.get(id) ?? { id, runIds: [], latest: '' }
      entry.runIds.push(run.runId)
      if (run.createdAt > entry.latest) entry.latest = run.createdAt
      byId.set(id, entry)
    }
  }
  const entries = [...byId.values()]
  const recurrences = entries
    .filter((entry) => entry.runIds.length >= 2)
    .sort((a, b) => b.runIds.length - a.runIds.length || b.latest.localeCompare(a.latest))
  const singles = entries.filter((entry) => entry.runIds.length === 1)
  return { recurrences, singles, unattributedRuns }
}

/** `[project] path/to/x.test.ts` -> `path/to/x.test.ts`. */
export function pathFromTestId(id) {
  const match = /^\[[^\]]+\] (.+)$/.exec(id)
  return match === null ? null : match[1]
}

/**
 * The window is a trailing one, so it keeps holding a flake for days after
 * somebody fixed it — and the report below tells a session to spend a fix
 * lane. Measured 2026-09-21: two 09-12/09-13 failures of a touch-tap test
 * were still being reported as a promotion signal on 09-21, by which point
 * the root cause had been found and fixed across seven commits. Nothing in
 * the report said so, and a session nearly spent the lane.
 *
 * git already knows. `inspect(path, sinceIso)` answers whether the test's
 * own file has moved since that entry's newest failure, in the same three
 * states `stale-issues.mjs` uses for the same question about an issue's
 * sources. It reports "what this is about moved", never "this is fixed" —
 * a fix that landed in a file the test never names is invisible to it, and
 * so is a flake that survived every one of those commits.
 *
 * Optional and fail-soft on purpose: without an inspector, or when one
 * throws, the report is exactly what it was before. A wrong "nothing has
 * touched this file since" is worse than no line at all, because it reads
 * as evidence.
 */
function fileStatusLine(entry, inspect) {
  if (typeof inspect !== 'function') return []
  const path = pathFromTestId(entry.id)
  if (path === null) return []
  let status
  try {
    status = inspect(path, entry.latest)
  } catch {
    return []
  }
  if (status?.state === 'missing') return ['      this file no longer exists']
  if (status?.state === 'unchanged') return ['      nothing has touched this file since']
  if (status?.state === 'changed') {
    return [
      `      ${status.commits} commit(s) have touched this file since, newest: ${status.newest}`,
      '      -> verify the flake still reproduces before spending a lane',
    ]
  }
  return []
}

/** One line per recurrence; silence when there is none is the caller's job. */
export function formatReport({ recurrences, singles, unattributedRuns }, windowDays, inspect) {
  if (recurrences.length === 0) return ''
  const lines = [
    `[flake-watch] ${recurrences.length} test(s) failed main CI more than once in ${windowDays} days — the second occurrence is the promotion signal (integrator-flow.md):`,
    '',
  ]
  for (const entry of recurrences) {
    lines.push(`  ${entry.runIds.length}x ${entry.id}`)
    lines.push(`      runs: ${entry.runIds.join(', ')} (newest ${entry.latest.slice(0, 10)})`)
    lines.push(...fileStatusLine(entry, inspect))
  }
  lines.push('')
  lines.push(
    `  (${singles.length} single-occurrence test failure(s) and ${unattributedRuns.length} run(s) with no test annotation — infra-shaped — not listed.)`,
  )
  lines.push('')
  lines.push(
    '  Act on the >=2x entries NOW: launch a root-cause fix lane each (own worktree + dev-loop) — re-running is how a defect gets waved through. An entry marked above has MOVED since it last failed: re-check that one, and search the issue store for its file, before spending the lane.',
  )
  return lines.join('\n')
}
