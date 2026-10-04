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
 * `flake-shapes.md`'s ninth, tenth and eleventh shapes all report every
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

/**
 * Whether instant `a` is later than instant `b`.
 *
 * The Actions API stamps a run in UTC (`...Z`) while `git log --format=%cI`
 * keeps the committer's own offset, and two ISO strings in different offsets
 * do not order as text: `17:06Z` is eleven thousand seconds after
 * `22:57+09:00` and sorts before it. Anything unparseable is "not later", so
 * a malformed date never retires or counts a flake on a guess.
 */
export function instantIsAfter(a, b) {
  const left = Date.parse(a)
  const right = Date.parse(b)
  return Number.isFinite(left) && Number.isFinite(right) && left > right
}

/** Whether any of the listed successful runs was created after `iso`. */
export function runPassedAfter(passedRuns, iso) {
  return passedRuns.some((run) => instantIsAfter(run.createdAt, iso))
}

/**
 * The `%cI<TAB>subject` lines of a `git log` whose commit landed after
 * `sinceIso`, as `[committedAt, subject]` pairs in log order.
 */
export function commitsLandedAfter(logOutput, sinceIso) {
  return logOutput
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      return tab === -1 ? [line, ''] : [line.slice(0, tab), line.slice(tab + 1)]
    })
    .filter(([committedAt]) => instantIsAfter(committedAt, sinceIso))
}

/**
 * Where a run's cached annotations live.
 *
 * A completed run's annotations never change, so what one checkout fetched is
 * every checkout's. The git common dir is the one directory all of a clone's
 * worktrees share and none of them tracks, so a worktree created today reads
 * what the main checkout fetched last week instead of paying the whole
 * window's API round trips in a SessionStart hook. Without a git common dir
 * (not a repository, git absent) the cache falls back to the checkout's own
 * git-ignored `tmp/`.
 */
export function flakeCacheDir({ gitCommonDir, root }) {
  return typeof gitCommonDir === 'string' && gitCommonDir !== ''
    ? `${gitCommonDir.replace(/[\\/]+$/, '')}/flake-watch`
    : `${root}/tmp/flake-watch`
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
      if (entry.latest === '' || instantIsAfter(run.createdAt, entry.latest))
        entry.latest = run.createdAt
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
function inspectEntry(entry, inspect) {
  if (typeof inspect !== 'function') return null
  // An unhandled-error entry carries the path its annotation named, which is
  // an ordinary source file rather than a test — the same question ("has
  // this moved since it last failed?") and a different kind of answer.
  const path = entry.path ?? pathFromTestId(entry.id)
  if (path === null || path === undefined) return null
  try {
    return inspect(path, entry.latest) ?? null
  } catch {
    return null
  }
}

function fileStatusLine(status) {
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
 * Why a recurrence no longer needs a lane, or null when it still might.
 *
 * Two independent signals, each stricter than "something moved":
 *  - a later commit's SUBJECT names the file (`status.namedBy`) — the shape a
 *    root-cause fix has. It need not touch the file and does not wait for a
 *    pass, because the subject is the author saying what it was about;
 *  - the file changed after the entry's newest failure AND a main run
 *    created after that change passed (`passedAfter`). The pass alone proves
 *    nothing — a flake failing one run in ten passes the next by chance — and
 *    the change alone is only "what this is about moved", so both are needed.
 *
 * An unreadable `passedAfter` answers "unknown", never "passed": a wrong drop
 * hides a live flake, which is worse than a stale line.
 */
function whyRetired(status, passedAfter) {
  if (typeof status?.namedBy === 'string' && status.namedBy !== '') return 'named by a later commit'
  if (status?.state !== 'changed') return null
  if (typeof passedAfter !== 'function' || typeof status.newestAt !== 'string') return null
  try {
    return passedAfter(status.newestAt) === true
      ? 'changed since its last failure and a later main run passed'
      : null
  } catch {
    return null
  }
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

/**
 * One line per recurrence; silence when there is none is the caller's job.
 *
 * @param inspect     `(path, sinceIso) => status`, whether the file moved since
 * @param passedAfter `(iso) => boolean`, whether a main run created after `iso` passed
 */
export function formatReport(
  { recurrences, singles, unattributedRuns },
  windowDays,
  inspect,
  passedAfter,
) {
  const inspected = recurrences.map((entry) => ({ entry, status: inspectEntry(entry, inspect) }))
  const retired = new Map()
  for (const { entry, status } of inspected) {
    const why = whyRetired(status, passedAfter)
    if (why !== null) retired.set(entry.id, why)
  }
  const live = inspected.filter(({ entry }) => !retired.has(entry.id))
  if (live.length === 0) return ''
  const lines = [
    `[flake-watch] ${live.length} test(s) failed main CI more than once in ${windowDays} days — the second occurrence is the promotion signal (integrator-flow.md):`,
    '',
  ]
  for (const { entry, status } of live) {
    lines.push(`  ${entry.runIds.length}x ${entry.id}`)
    lines.push(`      runs: ${entry.runIds.join(', ')} (newest ${entry.latest.slice(0, 10)})`)
    lines.push(...fileStatusLine(status))
  }
  lines.push('')
  lines.push(
    `  (${singles.length} single-occurrence test failure(s) and ${unattributedRuns.length} run(s) with no test annotation — infra-shaped — not listed.)`,
  )
  if (retired.size > 0) {
    const reasons = [...new Set(retired.values())].join('; ')
    lines.push(`  (${retired.size} test(s) omitted: ${reasons}.)`)
  }
  lines.push(...unattributedLegLines(unattributedRuns))
  lines.push('')
  lines.push(
    '  Act on the >=2x entries NOW: launch a root-cause fix lane each (own worktree + dev-loop) — re-running is how a defect gets waved through. An entry marked above has MOVED since it last failed: re-check that one, and search the issue store for its file, before spending the lane.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Failures that are not vitest annotations.
//
// The window above only sees a failed `ci` run, so a failed image push, a
// cancelled scheduled lane or a failed advisory audit was visible to nobody
// but whoever opened the Actions tab. The rule here is the one the vitest
// half uses — what a later success retires — applied to what each of these
// is actually a statement about.

const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure'])

/** The `release.yml` jobs whose failure strands an artifact rather than failing a check. */
export const PUBLISH_JOBS = ['publish-mcp', 'docker-publish-sign']

/**
 * Whether a `release` run is worth fetching the jobs of.
 *
 * Every push to main runs the workflow and nearly all of them skip every
 * publish job, so reading jobs for all of them costs one API call per push
 * for nothing. Only a run that failed, was dispatched by hand, or is
 * release-please's own merge can have run a publish job — and the last of
 * those is what supplies the later SUCCESS that retires an earlier failure.
 */
export function inspectPublishJobs(run) {
  return (
    FAILED_CONCLUSIONS.has(run.conclusion) ||
    run.event === 'workflow_dispatch' ||
    /^chore(\([^)]*\))?!?: release\b/.test(run.title ?? '')
  )
}

/**
 * Publish jobs whose newest real run did not succeed.
 *
 * Judged per JOB, never per run: the push after the failed release runs the
 * workflow again with every publish job skipped, the run concludes
 * `success`, and a run-level "last success" would call the stranded image
 * healed. A skipped job says nothing either way, so it is not evidence.
 *
 * @param runs `{ runId, createdAt, jobs: { name, conclusion }[] }[]`, any order
 */
export function unhealedPublishJobs(runs) {
  const unhealed = []
  for (const job of PUBLISH_JOBS) {
    let newest = null
    for (const run of runs) {
      const conclusion = run.jobs?.find((candidate) => candidate.name === job)?.conclusion
      if (conclusion !== 'success' && !FAILED_CONCLUSIONS.has(conclusion)) continue
      if (newest === null || instantIsAfter(run.createdAt, newest.createdAt)) {
        newest = { job, runId: run.runId, createdAt: run.createdAt, conclusion }
      }
    }
    if (newest !== null && newest.conclusion !== 'success') unhealed.push(newest)
  }
  return unhealed
}

/**
 * A workflow's runs that failed or were cancelled after its newest success,
 * or null when nothing has. A run still in progress has no conclusion yet and
 * is neither.
 *
 * @param runs `{ runId, createdAt, conclusion }[]`, any order
 */
export function unhealedWorkflowRuns(runs) {
  let lastSuccessAt = null
  for (const run of runs) {
    if (
      run.conclusion === 'success' &&
      (lastSuccessAt === null || instantIsAfter(run.createdAt, lastSuccessAt))
    ) {
      lastSuccessAt = run.createdAt
    }
  }
  const failed = runs.filter(
    (run) =>
      FAILED_CONCLUSIONS.has(run.conclusion) &&
      (lastSuccessAt === null || instantIsAfter(run.createdAt, lastSuccessAt)),
  )
  if (failed.length === 0) return null
  const newest = failed.reduce((a, b) => (instantIsAfter(b.createdAt, a.createdAt) ? b : a))
  return {
    count: failed.length,
    newest: { runId: newest.runId, createdAt: newest.createdAt, conclusion: newest.conclusion },
    lastSuccessAt,
  }
}

/** One block, or '' when nothing is unhealed — the caller prints nothing for ''. */
export function formatUnhealedReport({ publishJobs, workflows }) {
  if (publishJobs.length === 0 && workflows.length === 0) return ''
  const lines = [
    '[flake-watch] failures on main that no later success has retired (not test failures):',
    '',
  ]
  for (const entry of publishJobs) {
    lines.push(
      `  release: ${entry.job} ${entry.conclusion} on ${entry.createdAt.slice(0, 10)} (run ${entry.runId}), and no later run of that job succeeded — the artifact it publishes may be missing.`,
    )
  }
  for (const entry of workflows) {
    const since =
      entry.lastSuccessAt === null
        ? 'no success on record'
        : `last success ${entry.lastSuccessAt.slice(0, 10)}`
    lines.push(
      `  ${entry.workflow}: ${entry.count} run(s) failed or were cancelled since (newest ${entry.newest.conclusion} ${entry.newest.createdAt.slice(0, 10)}, run ${entry.newest.runId}); ${since}.`,
    )
  }
  return lines.join('\n')
}
