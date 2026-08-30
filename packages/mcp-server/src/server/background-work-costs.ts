// What each background worker costs the serving loop, in one place.
//
// Separate from `background-work.ts` (which defines the registry) and from
// the composition roots (which arm the workers) for two reasons, both of
// which were live defects before this file existed.
//
// The declarations were COPIED between `http-server.ts` and
// `server-mode-http.ts` — the same paragraph of prose and the same number in
// two files, kept in step by whoever remembered. Every one of them was
// updated by hand twice in a single day.
//
// And nothing read them. `stallCeilingMs` is asserted by the test named in
// its own `fixture`, which can only import it from somewhere neither
// composition root has to be started to reach. That is what turns the
// declaration from prose into a contract: a worker that gets slower fails
// its own test rather than leaving a number that is quietly wrong.

import type { LoopCost } from './background-work.js'

/**
 * Ceilings sit roughly 4-5x above the worst reading observed locally, and
 * that width is deliberate. CI runners are slower and contended, and a bound
 * that fails on a busy machine gets raised until it means nothing — this
 * repo has already had two absolute thresholds fail in CI at exactly their
 * value. What this catches is the order-of-magnitude regression the field
 * exists for: the defect it replaced was 100x, not 2x.
 */
export const LOOP_COSTS = {
  'idle-shutdown': {
    runs: 'in-process',
    stallCeilingMs: 0,
    fixture: 'a comparison of two timestamps; there is no call here to measure',
    measuredOn: '2026-08-30',
  },
  'file-gc-sweeper': {
    runs: 'in-process',
    // Not a subprocess, even though the cost is the backup's shape: the write
    // barrier that stops a concurrent save inserting a reference between the
    // scan and the unlinks is in-process, and a child would not take it. So
    // the pass yields between scan units instead.
    stallCeilingMs: 200,
    fixture:
      'asserted by file-gc-loop-availability.test.ts, which grows documents at 8 versions ' +
      'each until a pass is long enough to measure and reads 26-35ms there. By hand at a ' +
      'larger fixture: the same pass without its yields stalls 1342ms unbroken, and 5 ' +
      'documents at 20 versions each stalls 7404ms.',
    measuredOn: '2026-08-30',
  },
  'workspace-tail': {
    runs: 'in-process',
    // Paid on the operator's interval rather than once a night, which is why
    // it yields per workspace too.
    stallCeilingMs: 150,
    fixture:
      'asserted by workspace-tail-loop-availability.test.ts, which grows workspaces at 30 ' +
      'commits of history until a pass is long enough to measure and reads 20-29ms there. ' +
      'The stall tracks ONE workspace catch-up, so it grows with the RECORD and not with ' +
      'how many there are — by hand, at 10 workspaces on file-backed libSQL: 7.7ms at 30 ' +
      'commits of history with a 10-commit gain, 105ms at 100/50, 283ms at 300/50. 300 ' +
      'commits is a small workspace, so treat that as a floor. Without the yield the same ' +
      'pass stalls 2927ms unbroken. An import is one call, so batching what catchUp ' +
      'imports is the only way lower.',
    measuredOn: '2026-08-30',
  },
  'backup-scheduler': {
    runs: 'subprocess',
    because:
      'the snapshot step blocks the event loop for its whole duration — measured 1242ms ' +
      'at a 103MB database and 4767ms at 421MB, growing with the data',
  },
} satisfies Record<string, LoopCost>

/**
 * The ceiling a loop-availability test asserts against, by worker name.
 *
 * Narrows away the `subprocess` arm so a test cannot silently assert against
 * a declaration that carries no ceiling — which would pass by reading
 * `undefined` into a comparison that is false either way.
 */
export function stallCeilingMs(name: keyof typeof LOOP_COSTS): number {
  const cost: LoopCost = LOOP_COSTS[name]
  if (cost.runs !== 'in-process') {
    throw new Error(`${name} runs in a subprocess and declares no stall ceiling`)
  }
  return cost.stallCeilingMs
}
