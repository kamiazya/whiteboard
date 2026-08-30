/**
 * How much of a piece of work's wall clock the event loop could still serve
 * anything in.
 *
 * This is the instrument behind `background-work.ts`'s `stallCeilingMs`.
 * Blocking is invisible in source — an `await` on a native binding reads
 * exactly like an `await` on a socket — so "does this stall the daemon" is
 * only ever answerable by measurement, and a measurement everyone rolls
 * themselves is one everyone gets wrong the same way.
 *
 * The trap it exists to remove: a sampler that records NOTHING is reporting
 * total blockage, not none. A hand-rolled version of this reported
 * `worstStall=0ms` at every database size while the loop was in fact frozen
 * for the whole of each run — its `Math.max` never ran, so the initial value
 * was published as the result, and the worst possible state read as the best
 * possible number. Here `blockedMs` is derived from the ticks that are
 * MISSING rather than from the ones that arrived, so zero samples across a
 * 4.7-second call reports 4.7 seconds blocked, which is what happened.
 */

export interface LoopAvailability {
  elapsedMs: number
  /** Wall clock in which the loop ran nothing: elapsed minus what ticked. */
  blockedMs: number
  /**
   * The longest single stretch the loop ran nothing.
   *
   * The number the registry declares, because it is what a request arriving
   * mid-pass actually waits: a second of CPU in twenty-millisecond pieces is
   * a busy daemon, the same second unbroken is a gone one.
   *
   * A stall that runs to the END of the body has no tick after it to bound
   * it, so the final stretch is closed off against the body's own completion
   * rather than left unmeasured. Without that it reported **0.3ms for a
   * 200ms stall** — not a weaker answer but the best-looking possible number
   * for the worst case, which is the exact failure this instrument exists to
   * remove, arriving through its other field.
   *
   * Still read it beside `blockedMs`, never instead: this says no single
   * stall swallowed the pass, that says how much of the pass was stalled at
   * all.
   */
  worstStallMs: number
  samples: number
  intervalMs: number
}

export interface LoopAvailabilityResult<T> {
  result: T
  availability: LoopAvailability
}

/**
 * Run `body` while sampling the loop, and report both.
 *
 * `intervalMs` is the resolution: a stall shorter than one interval is not
 * distinguishable from scheduling noise, so pick it well below the effect
 * being measured rather than as small as possible.
 */
export async function measureLoopAvailability<T>(
  body: () => Promise<T>,
  options: { intervalMs?: number } = {},
): Promise<LoopAvailabilityResult<T>> {
  const intervalMs = options.intervalMs ?? 5
  let samples = 0
  let worstGapMs = 0
  let last = process.hrtime.bigint()
  const timer = setInterval(() => {
    const now = process.hrtime.bigint()
    worstGapMs = Math.max(worstGapMs, Number(now - last) / 1e6 - intervalMs)
    samples += 1
    last = now
  }, intervalMs)
  // Never the reason a process stays alive, the same rule every timer in the
  // server follows.
  timer.unref()

  const startedAt = process.hrtime.bigint()
  try {
    const result = await body()
    const endedAt = process.hrtime.bigint()
    const elapsedMs = Number(endedAt - startedAt) / 1e6
    // Close the final stretch against the body's completion. A stall that
    // runs to the end has no tick after it, so without this the longest one
    // in the run can be the one that goes unmeasured entirely.
    worstGapMs = Math.max(worstGapMs, Number(endedAt - last) / 1e6 - intervalMs)
    return {
      result,
      availability: {
        elapsedMs: round(elapsedMs),
        // Derived from the MISSING ticks, so a run that blocked throughout
        // reports its whole duration instead of its initial value.
        blockedMs: round(Math.max(0, elapsedMs - samples * intervalMs)),
        worstStallMs: round(samples === 0 ? elapsedMs : worstGapMs),
        samples,
        intervalMs,
      },
    }
  } finally {
    clearInterval(timer)
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * The share of the ticks the sampler ASKED for that actually landed.
 *
 * The scale-free way to say "the loop kept getting turns", and the one to
 * assert on. A raw `samples` count is a statement about how busy the machine
 * is: both loop-availability tests floored it at an absolute number
 * calibrated on an idle machine, and both failed in CI at exactly their
 * threshold (`expected 20 to be greater than 20`, `expected 5 to be greater
 * than 5`) without anything being wrong with the code under them.
 *
 * Measured across three regimes, which is what the 0.05 floor those tests use
 * is picked from:
 *
 *   blocked (the defect)   file-GC 3 of 279 = 0.011  ·  workspace-tail 0
 *   under load             0.18 - 0.24              ·  0.37 - 0.64
 *   idle                   0.35                     ·  0.55
 *
 * Read it beside `worstStallMs`, never instead: this says the loop ran
 * something, that says no single stall swallowed the pass.
 */
export function loopTurnShare(availability: LoopAvailability): number {
  return availability.samples / (availability.elapsedMs / availability.intervalMs)
}
