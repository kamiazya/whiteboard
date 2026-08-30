import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import type { LoopAvailability } from './loop-availability.js'
import { measureLoopAvailability } from './loop-availability.js'

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
 * **Every claim is a DIFFERENCE between two references measured in the same
 * run, never a bound in milliseconds and never a ratio.** The first version
 * of this suite used absolute bounds, and they were assertions about the
 * machine being quiet rather than about the instrument: under CPU contention
 * the loop really is starved, so `blockedMs` rises and the turn share falls,
 * and the suite went red with nothing wrong under it. Measured under 16
 * competing processes — the free-loop reference reported 70.5ms blocked
 * against 14.4ms idle, and the sub-interval one 1552.8ms against 56.4ms.
 *
 * A ratio is not enough either, and that was measured too: `chopped * 3 <
 * contiguous` was red at 624.2 against 529.6 under load and green idle,
 * because contention inflates both sides and a multiplier cannot absorb it.
 * A difference can — whatever the machine does lands on both references, and
 * subtracts away. What is left is the milliseconds the fixture itself put
 * there.
 *
 * That is the third machine-calibrated constant to fail in this repo, and
 * the second in this file's own subject.
 */
describe('calibrated against known truths', () => {
  async function stalls(body: () => Promise<unknown>): Promise<LoopAvailability> {
    const { availability } = await measureLoopAvailability(body, { intervalMs: 5 })
    return availability
  }

  it('tells a blocked loop from a free one', async () => {
    const free = await stalls(() => sleep(400))
    const solid = await stalls(async () => blockFor(400))

    // The coarsest thing the instrument can get wrong. The solid fixture
    // carries its own 400ms and the free one carries none, so the gap
    // between them is what the instrument saw rather than what the machine
    // was doing. Measured 399.3ms apart idle.
    expect(solid.worstStallMs - free.worstStallMs).toBeGreaterThan(100)
    // A solid block is blocked for its whole duration whatever else is
    // running — the loop gets no turn either way — so this one ratio does
    // hold where the others do not.
    expect(solid.blockedMs).toBeGreaterThan(solid.elapsedMs * 0.9)
    expect(solid.samples).toBe(0)
  })

  /**
   * The regression guard for the fix above, as the comparison that makes it
   * checkable: the same stall, moved from the start of a body to the end,
   * must still be seen.
   *
   * Both fixtures are the same 200ms of blocking and the same 150ms of
   * waiting, so a ratio is sound here in a way it is not above — there is no
   * asymmetry for contention to act on. Measured 197.2ms against 195.3ms
   * idle and 212.2ms against 249ms under load; before the fix the end-of-body
   * reading was 0.3ms.
   */
  it('sees a stall at the end of a body as well as one at the start', async () => {
    const atStart = await stalls(async () => {
      blockFor(200)
      await sleep(150)
    })
    const atEnd = await stalls(async () => {
      await sleep(150)
      blockFor(200)
    })

    expect(atEnd.worstStallMs).toBeGreaterThan(atStart.worstStallMs * 0.5)
  })

  /**
   * The resolution limit — the half of it that can be asserted.
   *
   * A stall shorter than one sampler interval hides between ticks. What that
   * does to `worstStallMs` is CORRECT and holds anywhere: 200ms of blocking
   * delivered in 2ms pieces really is a series of 2ms stalls and reads as
   * one.
   *
   * What it does to `blockedMs` is a genuine under-report — 56.4ms for 200ms
   * of real blocking — and is deliberately NOT asserted, because under
   * contention the instrument correctly counts starvation as blocking and the
   * comparison inverts outright: 1552.8ms for the chopped fixture against
   * 219.8ms for the contiguous one. There is no formulation of that claim
   * which is not "the machine was quiet", so it stays a measurement in prose
   * and `intervalMs` stays something the caller chooses knowingly.
   */
  it('reads many sub-interval stalls as the small stalls they are', async () => {
    const contiguous = await stalls(async () => blockFor(200))
    const chopped = await stalls(async () => {
      for (let i = 0; i < 100; i++) {
        blockFor(2)
        await sleep(0)
      }
    })

    // Reached, not assumed: the chopped fixture really did its work.
    expect(chopped.elapsedMs).toBeGreaterThan(150)
    // The contiguous fixture's worst stall carries its own 200ms; the
    // chopped one's carries only what the machine did to it.
    expect(contiguous.worstStallMs - chopped.worstStallMs).toBeGreaterThan(100)
  })
})
