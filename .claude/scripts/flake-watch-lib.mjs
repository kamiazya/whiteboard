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
 * The identity of an annotation that names no test.
 *
 * `integrator-flow.md`'s ninth, tenth and eleventh shapes all report every
 * test as PASSED and fail the FILE — so vitest annotates them
 * `Unhandled error`, with no project and no test path, and the run used to
 * fall into `unattributedRuns` where nothing could count it. The tenth
 * reached three hand-counted occurrences that way: the promotion threshold,
 * passed without a single automatic signal.
 *
 * What the annotation DOES carry is a path and a message whose first token
 * is the error class. Those two are the surface — the same
 * `EnvironmentTeardownError` at the same module twice is one flake by the
 * same rule as any other — and keying on the class as well as the path
 * matters, because a `TypeError` there is a different defect that happens
 * to share a file.
 *
 * Returns `null` when there is no path or no class to key on, which keeps
 * the runner's own "Process completed with exit code 1." (path `.github`,
 * empty title) out of the report as it always was.
 */
export function unhandledIdFrom(annotation) {
  const { title, path, message } = annotation ?? {}
  if (typeof title !== 'string' || title.trim() === '') return null
  if (typeof path !== 'string' || !path.includes('/')) return null
  const errorClass = /^([A-Z]\w*(?:Error|Exception))\b/.exec(String(message ?? '').trim())
  if (errorClass === null) return null
  return { id: `${errorClass[1]} @ ${path}`, path }
}

/**
 * The CI leg a run's `ci-gate` summary says died, e.g. `test-unit (2)`.
 *
 * Deliberately NOT an identity: two runs that both failed `test-unit (2)`
 * are not the same flake, and this report's tail tells a session to spend a
 * fix lane. A false promotion signal is worse than an uncountable failure —
 * which this file's own history has already paid for once. It is printed so
 * the bucket is readable, and left out of `clusterFailures`'s keying.
 */
export function failedLegFrom(annotation) {
  const match = /^\[ci-gate\]\s+(.+?):\s*failure\s*$/.exec(String(annotation?.message ?? '').trim())
  return match === null ? null : match[1]
}

/** A window entry's annotations, however the caller supplied them. */
function annotationsOf(run) {
  if (Array.isArray(run.annotations)) return run.annotations
  return (run.titles ?? []).map((title) => ({ title }))
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
    const annotations = annotationsOf(run)
    // A real test failure is the better identity, so it wins outright: an
    // unhandled error beside one is usually the same collapse seen from the
    // other end, and keying both would report one run as two flakes.
    const keyed = new Map()
    for (const annotation of annotations) {
      const testId = testIdFromTitle(annotation.title)
      if (testId !== null) keyed.set(testId, null)
    }
    if (keyed.size === 0) {
      for (const annotation of annotations) {
        const unhandled = unhandledIdFrom(annotation)
        if (unhandled !== null) keyed.set(unhandled.id, unhandled.path)
      }
    }
    if (keyed.size === 0) {
      const legs = [...new Set(annotations.map(failedLegFrom).filter((leg) => leg !== null))]
      unattributedRuns.push({ runId: run.runId, createdAt: run.createdAt, legs })
      continue
    }
    for (const [id, path] of keyed) {
      const entry = byId.get(id) ?? { id, path, runIds: [], latest: '' }
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
  // An unhandled-error entry carries the path its annotation named, which is
  // an ordinary source file rather than a test — the same question ("has
  // this moved since it last failed?") and a different kind of answer.
  const path = entry.path ?? pathFromTestId(entry.id)
  if (path === null || path === undefined) return []
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

/**
 * Which CI legs the unattributed runs died on — information, not a claim.
 *
 * Without it the report says "4 run(s) with no test annotation" and a reader
 * has four Actions pages to open before knowing whether they are one thing
 * or four. With it they can see at a glance that three were `test-unit (2)`
 * and one was `test-shared`, which is where to look — and the wording says
 * so rather than saying anything about recurrence.
 */
function unattributedLegLines(unattributedRuns) {
  const counts = new Map()
  for (const run of unattributedRuns) {
    for (const leg of run.legs ?? []) counts.set(leg, (counts.get(leg) ?? 0) + 1)
  }
  if (counts.size === 0) return []
  const listed = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([leg, count]) => `${count}x ${leg}`)
    .join(', ')
  return [
    `  Those runs died on: ${listed}. A leg name says WHICH job, never why, so it is`,
    '  not counted as a recurrence — open the run to see what failed.',
  ]
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
  lines.push(...unattributedLegLines(unattributedRuns))
  lines.push('')
  lines.push(
    '  Act on the >=2x entries NOW: launch a root-cause fix lane each (own worktree + dev-loop) — re-running is how a defect gets waved through. An entry marked above has MOVED since it last failed: re-check that one, and search the issue store for its file, before spending the lane.',
  )
  return lines.join('\n')
}
