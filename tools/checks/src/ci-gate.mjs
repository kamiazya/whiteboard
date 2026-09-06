#!/usr/bin/env node

// The single required status check for ci.yml.
//
// Branch protection names CHECKS, and a matrix job's checks are named per leg
// (`test-jsdom (1)`). So every change to a shard count renames the checks and
// silently stops satisfying the required list — a bare `test-jsdom` that no
// longer reports blocks every merge with "Required status check is expected",
// which is what happened when test-jsdom was first sharded. Requiring THIS job
// instead makes the shard count an implementation detail of the workflow.
//
// Two things make that safe rather than merely convenient, and both are the
// point:
//
//   - `skipped` is allowed per job, with a reason, never as a blanket. A job
//     that fails to start also reports `skipped`, so a gate that waves it
//     through is a gate that passes when the workflow is broken.
//   - the gate is only as good as its `needs` list, and a forgotten entry is
//     invisible — nothing is red, a job simply stops being gated. That is what
//     ci-gate.test.ts checks: every job in ci.yml is either needed here or
//     exempted by name.

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

/**
 * @param {Record<string, {result?: string}>} needs the `toJSON(needs)` payload
 * @returns {string[]} one line per problem; empty means the gate passes
 */
export function gateFailures(needs) {
  if (needs === null || typeof needs !== 'object') {
    // Not "no problems": an unreadable payload means the gate checked nothing.
    return ['the needs payload was not an object, so no job result was checked']
  }
  const entries = Object.entries(needs)
  if (entries.length === 0) {
    return ['the needs payload was empty, so no job result was checked']
  }
  /** @type {string[]} */
  const problems = []
  for (const [job, value] of entries) {
    const result = value?.result
    if (result === 'success') continue
    if (result === 'skipped' && job in SKIPPABLE_JOBS) continue
    if (result === 'skipped') {
      problems.push(
        `${job}: skipped, which is not a declared outcome for it — a job that fails to start also reports skipped. ` +
          'Add it to SKIPPABLE_JOBS with the reason if the skip is deliberate.',
      )
      continue
    }
    problems.push(`${job}: ${result ?? 'no result'}`)
  }
  return problems
}

function main() {
  const raw = process.env.NEEDS_JSON
  if (raw === undefined || raw === '') {
    process.stderr.write('[ci-gate] NEEDS_JSON is unset; refusing to report success\n')
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(`[ci-gate] NEEDS_JSON is not JSON: ${err}\n`)
    process.exit(1)
  }
  const problems = gateFailures(parsed)
  for (const [job, value] of Object.entries(parsed ?? {})) {
    process.stdout.write(`  ${job}: ${value?.result ?? 'no result'}\n`)
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`::error::[ci-gate] ${problem}\n`)
    process.exit(1)
  }
  process.stdout.write('[ci-gate] every gated job succeeded\n')
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()
