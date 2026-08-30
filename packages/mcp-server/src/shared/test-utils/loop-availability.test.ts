import { describe, expect, it } from 'vitest'
import { measureLoopAvailability } from './loop-availability.js'

function blockFor(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Deliberately synchronous: this is what a native binding's `await` does
    // to the loop, which is the thing being measured.
  }
}

describe('measureLoopAvailability', () => {
  it('reports a loop that stayed free', async () => {
    const { availability } = await measureLoopAvailability(async () => {
      await new Promise((r) => setTimeout(r, 200))
      return 'done'
    })
    expect(availability.samples).toBeGreaterThan(10)
    expect(availability.blockedMs).toBeLessThan(100)
  })

  it('hands the body result back', async () => {
    const { result } = await measureLoopAvailability(async () => 42)
    expect(result).toBe(42)
  })

  it('reports a loop that was blocked for part of the run', async () => {
    const { availability } = await measureLoopAvailability(async () => {
      await new Promise((r) => setTimeout(r, 150))
      blockFor(200)
    })
    expect(availability.blockedMs).toBeGreaterThan(100)
    // NOT `worstStallMs`, which is 0.5ms here and correctly so: the stall runs
    // to the end of the body, and no tick ever lands after it to observe the
    // gap. `blockedMs` counts the ticks that are missing, so it sees a stall
    // the last-gap measure structurally cannot.
    expect(availability.worstStallMs).toBeLessThan(100)
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
})
