#!/usr/bin/env node

// The single required status check for ci.yml.
//
// Branch protection names CHECKS, and a matrix job's checks are named per leg
// (`test-jsdom (1)`). So every change to a shard count renames the checks and
// silently stops satisfying the required list — a bare `test-jsdom` that no
// longer reports blocks every merge with "Required status check is expected",
// which is what happened when test-jsdom was first sharded. Requiring THIS job
// instead makes the shard count an implementation detail of the workflow, and
// the per-leg names need not be in the required list at all.
//
// It judges the run's ACTUAL per-job conclusions, read back from the Actions
// API, rather than `needs.<job>.result`. That is deliberate: whether a matrix
// job's single `needs` result becomes `failure` when one leg fails is not
// stated by the docs for the needs context, the workflow syntax or the matrix
// how-to, and a gate whose correctness rests on an unverified mechanism is a
// gate that can pass over a failing shard. The API answers per LEG
// (`test-jsdom (1)`), so the question does not arise. `needs` stays, for
// ordering and as the declared coverage list this cross-checks against.
//
// Three ways an aggregate gate goes quietly wrong, each closed here:
//
//   - it checks nothing and reports "no problems found" — an empty or
//     unreadable job list is a failure, not a pass;
//   - a job runs but is not looked at — every name in `needs` must appear in
//     the run, so a job that vanished from the run fails the gate;
//   - `skipped` is waved through. A job that fails to start also reports
//     `skipped`, so it is allowed per job, with a reason.

/**
 * Jobs whose `skipped` is a legitimate outcome, each with the reason it can
 * happen. Anything not listed here must reach `success`.
 *
 * Keyed by job id; the guard test requires every key to name a real job that
 * actually carries a job-level `if:`, so an entry cannot outlive the condition
 * that justifies it.
 */
export const SKIPPABLE_JOBS = {
  'stress-changed-tests':
    "job-level `if: github.event_name == 'pull_request'`, so it does not run on push or merge_group",
}

/** `test-jsdom (1)` is a leg of the job `test-jsdom`. */
export function baseJobName(name) {
  const paren = name.indexOf(' (')
  return paren === -1 ? name : name.slice(0, paren)
}

/**
 * @param {{
 *   jobs: {name: string, status: string, conclusion: string | null}[],
 *   needed: string[],
 *   gateJobName: string,
 * }} input
 * @returns {string[]} one line per problem; empty means the gate passes
 */
export function gateFailures({ jobs, needed, gateJobName }) {
  if (!Array.isArray(jobs)) {
    // Not "no problems": an unreadable list means the gate checked nothing.
    return ['the run job list was not an array, so no job was checked']
  }
  const others = jobs.filter((job) => baseJobName(job.name) !== gateJobName)
  if (others.length === 0) {
    return ['the run reported no jobs besides the gate itself, so nothing was checked']
  }

  /** @type {string[]} */
  const problems = []

  // Every job the workflow declared must actually be in the run. A job that
  // silently stopped running would otherwise leave the gate green over a
  // shrinking set.
  const present = new Set(others.map((job) => baseJobName(job.name)))
  for (const name of needed) {
    if (!present.has(name)) problems.push(`${name}: declared in \`needs\` but absent from the run`)
  }

  for (const job of others) {
    if (job.status !== 'completed') {
      problems.push(`${job.name}: still ${job.status} when the gate ran`)
      continue
    }
    if (job.conclusion === 'success') continue
    if (job.conclusion === 'skipped' && baseJobName(job.name) in SKIPPABLE_JOBS) continue
    if (job.conclusion === 'skipped') {
      problems.push(
        `${job.name}: skipped, which is not a declared outcome for it — a job that fails to start ` +
          'also reports skipped. Add it to SKIPPABLE_JOBS with the reason if the skip is deliberate.',
      )
      continue
    }
    problems.push(`${job.name}: ${job.conclusion ?? 'no conclusion'}`)
  }
  return problems
}

async function fetchRunJobs(repo, runId, token) {
  /** @type {{name: string, status: string, conclusion: string | null}[]} */
  const jobs = []
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    })
    if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`)
    const body = await res.json()
    const batch = body.jobs ?? []
    jobs.push(...batch.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion })))
    if (jobs.length >= (body.total_count ?? jobs.length) || batch.length === 0) break
  }
  return jobs
}

async function main() {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_TOKEN: token } = process.env
  const needed = JSON.parse(process.env.NEEDS_JSON ?? 'null')
  const gateJobName = process.env.GATE_JOB_NAME ?? 'ci-gate'
  for (const [name, value] of Object.entries({ repo, runId, token })) {
    if (!value) {
      process.stderr.write(`[ci-gate] ${name} is unset; refusing to report success\n`)
      process.exit(1)
    }
  }
  if (needed === null || typeof needed !== 'object') {
    process.stderr.write('[ci-gate] NEEDS_JSON is unreadable; refusing to report success\n')
    process.exit(1)
  }

  let jobs
  try {
    jobs = await fetchRunJobs(repo, runId, token)
  } catch (err) {
    // A gate that cannot see the run must block, never wave the merge through.
    process.stderr.write(`[ci-gate] could not read this run's jobs: ${err}\n`)
    process.exit(1)
  }

  const problems = gateFailures({ jobs, needed: Object.keys(needed), gateJobName })
  for (const job of jobs) {
    process.stdout.write(`  ${job.name}: ${job.conclusion ?? job.status}\n`)
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`::error::[ci-gate] ${problem}\n`)
    process.exit(1)
  }
  process.stdout.write(`[ci-gate] every job in this run succeeded (${jobs.length} jobs)\n`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
