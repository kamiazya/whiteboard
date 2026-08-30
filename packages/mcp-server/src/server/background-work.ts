// Everything the daemon runs on its own, and the three questions each answer
// costs before it can be armed.
//
// This exists because the answers kept being made once and then forgotten.
// The backup pass was written to run on every instance (N backups a night,
// and N retention passes each deleting from a set the others were changing)
// and inside the serving process (a `VACUUM INTO` that blocks the event loop
// for as long as it runs — 1242ms at 103MB, 4767ms at 421MB). Both were real
// defects, both were invisible in a diff that looked like "add a scheduler",
// and neither would have been asked about by anything.
//
// So the registry is LOAD-BEARING, not documentation: the composition root
// starts and stops workers through `startBackgroundWork`, a worker with no
// declaration does not typecheck, and `background-work.guard.test.ts` fails
// on a `.start()` in the composition root that goes around it. The point is
// not that the answers here are enforced — nobody can mechanically check
// whether a stated reason is a good one — but that the questions cannot be
// skipped, and that all the answers sit in one file a reader can compare.
//
// The next thing that will want this is work that is neither cheap nor
// per-request: dispatching AI work off the serving instance. When it lands it
// answers the same three questions, in the same place, beside the answers
// that are already here.

import { getLogger } from './log.js'

const log = getLogger('background-work')

/** The shape the composition root drives. Anything long-lived can wear it. */
interface BackgroundWorker {
  start(): void
  stop(): Promise<void>
}

/**
 * Who runs this when several instances share one record (ADR-0020).
 *
 * `every-instance` is a real answer — a per-process concern like an idle
 * timer, or work that is cheap and idempotent — but it is one that has to be
 * SAID, because it is also what a worker gets by accident. `leader-only`
 * names the lease so the reader can find the coordination.
 */
type InstanceReach =
  | { runs: 'leader-only'; lease: string }
  | { runs: 'every-instance'; because: string }

/**
 * What this costs the loop that is serving requests.
 *
 * `in-process` carries a MEASURED figure and the date it was taken, not an
 * estimate: the whole reason this field exists is that a blocking call is
 * indistinguishable from a non-blocking one in the source. Use
 * `measureLoopAvailability` (shared/test-utils/loop-availability.ts) to
 * produce it, and note that a sampler which records nothing is reporting
 * total blockage, not none — that mistake is why the number has to come from
 * a shared instrument rather than a hand-rolled one.
 */
type LoopCost =
  | { runs: 'in-process'; measuredBlockMs: number; measuredOn: string }
  | { runs: 'subprocess'; because: string }

export interface BackgroundWork {
  /** Short name, used in logs and in the guard's failure message. */
  name: string
  /** What makes it run: a cron expression, an interval, an event. */
  trigger: string
  instances: InstanceReach
  loop: LoopCost
  /**
   * The worker itself, or `null` when this deployment did not arm it — a
   * setting left unset, a feature switched off. Declared either way, so the
   * registry lists what the daemon CAN run rather than what today's
   * environment happens to have turned on.
   */
  worker: BackgroundWorker | null
}

export interface BackgroundWorkHandle {
  /** Stops every armed worker, in declaration order, never throwing. */
  stopAll(): Promise<void>
  /** What was declared, for the runtime status surface and for tests. */
  declared: readonly BackgroundWork[]
}

/**
 * Arm everything declared, and hand back one way to stop it all.
 *
 * One stop path rather than three. Before this, the workers were started in
 * one place and stopped in two others (a graceful close and a bind-failure
 * handler), with a different call shape each — which is how a worker ends up
 * stopped on one path and left running on the other.
 */
export function startBackgroundWork(declared: readonly BackgroundWork[]): BackgroundWorkHandle {
  for (const work of declared) {
    work.worker?.start()
  }
  return {
    declared,
    async stopAll(): Promise<void> {
      for (const work of declared) {
        // Never throws: one worker refusing to stop must not leave the rest
        // running, and shutdown is not the moment to surface it as a failure.
        try {
          await work.worker?.stop()
        } catch (err) {
          log.warning({ work: work.name, err }, 'a background worker did not stop cleanly')
        }
      }
    },
  }
}
