/**
 * How much of a piece of work's wall clock the event loop could still serve
 * anything in.
 *
 * This is the instrument behind `background-work.ts`'s `worstStallMs`.
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

interface LoopAvailability {
  elapsedMs: number
  /** Wall clock in which the loop ran nothing: elapsed minus what ticked. */
  blockedMs: number
  /**
   * The longest single gap between ticks, or the whole run if none ticked.
   *
   * Weaker than `blockedMs` and deliberately kept beside it: a stall that
   * runs to the END of the body is invisible here, because no tick lands
   * after it to measure the gap — measured at 0.5ms for a body that awaited
   * 150ms and then blocked 200ms, where `blockedMs` correctly reported 205ms.
   * Read it for the shape of a stall, never as the answer to "did this
   * block".
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
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
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
