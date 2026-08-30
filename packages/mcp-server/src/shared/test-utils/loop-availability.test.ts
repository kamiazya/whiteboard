import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { loopTurnShare, measureLoopAvailability } from './loop-availability.js'

function blockFor(ms: number): void {
  // Spins on the monotonic clock rather than Date.now: this stands in for a
  // native binding's `await`, and it has to occupy the wall clock it claims.
  const until = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6))
  while (process.hrtime.bigint() < until) {
    // Deliberately synchronous — that is the thing being measured.
  }
}

describe('measureLoopAvailability', () => {
  it('hands the body result back', async () => {
    const { result } = await measureLoopAvailability(async () => 42)
    expect(result).toBe(42)
  })

  /**
   * The counterexample this instrument exists for, pinned as an example test.
   *
   * A hand-rolled sampler reported `worstStall=0ms` for exactly this case —
   * the loop frozen from the first instant to the last, so the callback that
   * would have recorded a stall never ran, and the initial value was
   * published as the measurement. The worst possible state read as the best
   * possible number, and it was believed across four database sizes before
   * anyone checked the sample count.
   */
  it('reports total blockage as blocked, not as quiet', async () => {
    const { availability } = await measureLoopAvailability(
      async () => {
        blockFor(300)
      },
      { intervalMs: 5 },
    )
    expect(availability.samples).toBe(0)
    expect(availability.blockedMs).toBeGreaterThan(250)
    expect(availability.worstStallMs).toBeGreaterThan(250)
  })

  /**
   * The same failure, arriving through the other field, and it was live here
   * until it was measured.
   *
   * A stall that runs to the END of the body has no tick after it to bound
   * the gap, so the longest stall in the run was the one that went
   * unrecorded: **0.3ms reported for a 200ms stall**. This test asserted that
   * as correct (`worstStallMs < 100`, with a comment explaining why the wrong
   * answer was right) until a calibration against known truths showed the
   * field that the registry actually declares returning the best-looking
   * possible number for the worst case — which is the defect the test above
   * exists to keep out.
   *
   * Closing the final stretch against the body's own completion fixes it:
   * 196.2ms against E's 195.3ms for the same stall at the start of a run.
   */
  it('sees a stall that runs to the end of the body', async () => {
    const { availability } = await measureLoopAvailability(async () => {
      await sleep(150)
      blockFor(200)
    })
    expect(availability.blockedMs).toBeGreaterThan(100)
    expect(availability.worstStallMs).toBeGreaterThan(100)
  })
})

/**
 * The instrument against known truths.
 *
 * Every number this repo's background-work declarations carry comes out of
 * here, so "is it accurate" is a question someone has to have asked. Nobody
 * had: it was written, trusted for three declarations, and only calibrated
 * when the end-of-body case above turned out to be wrong by three orders of
 * magnitude.
 *
 * Bounds are wide on purpose. The subject is whether the instrument reports
 * the right THING — a real stall as a stall, a free loop as free — not
 * whether it is accurate to the millisecond on a contended runner. A tight
 * bound here would be the machine-dependent constant that has already failed
 * this repo's CI twice.
 */
describe('calibrated against known truths', () => {
  const references = [
    {
      name: 'a loop left free throughout',
      body: () => sleep(400),
      // Truth: 0 blocked. Measured 15.4ms, which is timer scheduling, not
      // stalling — and the reason `blockedMs` is read as a magnitude rather
      // than an exact figure.
      blocked: [0, 100],
      worst: [0, 50],
    },
    {
      name: 'one solid block',
      body: async () => blockFor(400),
      // Truth: 400 / 400. Measured 400.1 / 400.1, from zero samples.
      blocked: [300, 900],
      worst: [300, 900],
    },
    {
      name: 'alternating work and waiting',
      body: async () => {
        for (let i = 0; i < 10; i++) {
          blockFor(20)
          await sleep(20)
        }
      },
      // Truth: 200 blocked in 20ms pieces. Measured 205 / 20.5 — the shape
      // the yields in file-gc and workspace-tail produce, and the reason the
      // two fields are read together.
      blocked: [120, 500],
      worst: [10, 80],
    },
    {
      name: 'a block at the start',
      body: async () => {
        blockFor(200)
        await sleep(150)
      },
      // Truth: 200 / 200. Measured 200.4 / 195.3.
      blocked: [120, 500],
      worst: [100, 400],
    },
  ] as const

  for (const reference of references) {
    it(`reports ${reference.name}`, async () => {
      const { availability } = await measureLoopAvailability(reference.body, { intervalMs: 5 })
      expect(availability.blockedMs).toBeGreaterThanOrEqual(reference.blocked[0])
      expect(availability.blockedMs).toBeLessThanOrEqual(reference.blocked[1])
      expect(availability.worstStallMs).toBeGreaterThanOrEqual(reference.worst[0])
      expect(availability.worstStallMs).toBeLessThanOrEqual(reference.worst[1])
    })
  }

  /**
   * The resolution limit, pinned as a limit rather than left to be discovered.
   *
   * A stall shorter than one sampler interval hides between ticks, so a
   * workload made of many sub-interval blocks reports a fraction of its true
   * blocking and a healthy-looking turn share. Measured: 100 blocks of 2ms
   * against a 5ms interval is 200ms of real blocking reported as 46.7ms, at a
   * share of 0.85.
   *
   * That is the whole content of "pick `intervalMs` well below the effect
   * being measured", made checkable. It is also why it is not a defect worth
   * fixing here: 2ms stalls are what a healthy pass looks like, and the field
   * the registry declares — the longest single stall — is right in this case
   * even though the total is not.
   */
  it('cannot see stalls shorter than its own interval, and that is the limit', async () => {
    const { availability } = await measureLoopAvailability(
      async () => {
        for (let i = 0; i < 100; i++) {
          blockFor(2)
          await sleep(0)
        }
      },
      { intervalMs: 5 },
    )

    // Reached, not assumed: the fixture really did spend most of its time
    // blocking, so what follows is a statement about the instrument.
    expect(availability.elapsedMs).toBeGreaterThan(200)
    // Under-reports the total by a wide margin — the limit itself.
    expect(availability.blockedMs).toBeLessThan(availability.elapsedMs * 0.5)
    // And says so nowhere in the turn share, which reads healthy.
    expect(loopTurnShare(availability)).toBeGreaterThan(0.5)
  })
})
