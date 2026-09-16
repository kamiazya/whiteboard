import { describe, expect, it, vi } from 'vitest'
import { resizeOrExplain } from './viewport-resize.js'

/**
 * The decision `setViewport` makes when a resize does not settle.
 *
 * A browser cannot be asked to refuse a resize on demand — the refusing state
 * belongs to another iframe and arrives by luck — so the effects are injected
 * and this runs in jsdom, which is the nearest layer that can state the rule
 * at all. What it pins is the part that makes the next real occurrence
 * readable: bounded rather than a 60s timeout, retried once, and a message
 * that says which of the helper's two hypotheses the run just produced.
 */
const NEVER = () => new Promise<never>(() => {})

/**
 * `n` macrotask turns, which is what an unhandled rejection needs to be
 * REPORTED — it is raised at the end of a turn, not at the rejection itself.
 * A zero-millisecond timeout yields a turn and waits for no duration, so this
 * is a wait on the event loop rather than on a guess about how slow it is.
 */
async function yieldTurns(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('resizeOrExplain', () => {
  it('clears the blockers before the resize, not after', async () => {
    const order: string[] = []
    await resizeOrExplain(
      async () => order.push('resize'),
      async () => {
        order.push('clear')
      },
      'a resize to 800x600',
    )
    expect(order).toEqual(['clear', 'resize'])
  })

  it('returns as soon as the resize settles, without retrying', async () => {
    const resize = vi.fn(async () => {})
    const clear = vi.fn(async () => {})
    await resizeOrExplain(resize, clear, 'a resize to 800x600')
    expect(resize).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  /**
   * Hypothesis 2 of the two on `setViewport`: another iframe held fullscreen
   * across the first attempt and let go. A retry is what tells that apart
   * from a state no page-side API can clear, so it has to actually succeed.
   */
  it('retries once after clearing again, and a transient blocker passes', async () => {
    const clear = vi.fn(async () => {})
    let attempt = 0
    const resize = vi.fn(() => {
      attempt += 1
      return attempt === 1 ? NEVER() : Promise.resolve()
    })
    await resizeOrExplain(resize, clear, 'a resize to 800x600', 20)
    expect(resize).toHaveBeenCalledTimes(2)
    expect(clear).toHaveBeenCalledTimes(2)
  })

  /**
   * The whole point: a bounded, self-naming failure in place of vitest's
   * `Test timed out in 60000ms`, which names the victim and not the cause.
   */
  it('throws inside the budget, naming setWindowBounds and what twice means', async () => {
    const started = performance.now()
    await expect(resizeOrExplain(NEVER, async () => {}, 'a resize to 800x600', 20)).rejects.toThrow(
      /setWindowBounds/,
    )
    // Two attempts at the budget, not one 60s test timeout. A ceiling with
    // generous headroom over 2x20ms: the assertion is "bounded", not "fast".
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('names the request, so a run with several resizes says which one', async () => {
    await expect(resizeOrExplain(NEVER, async () => {}, 'a resize to 1280x900', 5)).rejects.toThrow(
      /a resize to 1280x900/,
    )
  })

  /**
   * A refused `setWindowBounds` rejects long after this gave up, and an
   * unhandled rejection belonging to no test is the SECOND mystery the
   * original flake produced. What this pins is narrow and worth stating
   * exactly: the promise THIS helper is handed does not become one. The
   * provider's own internal rejection is not reachable from here and still
   * arrives — see `viewport-resize.ts`.
   *
   * Watched on `process`, not on the window, because that is where it arrives
   * — probed, not assumed. The first version listened for `unhandledrejection`
   * on `globalThis`, measured `win=0 proc=1`, and passed against an
   * implementation that leaks: a guard watching a channel nothing uses reads
   * exactly like a guard that checked.
   */
  it('swallows a rejection that arrives after the budget has expired', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let refuse: (reason: Error) => void = () => {}
      const late = new Promise((_resolve, reject) => {
        refuse = reject
      })
      await expect(
        resizeOrExplain(
          () => late,
          async () => {},
          'a resize to 800x600',
          1,
        ),
      ).rejects.toThrow(/setWindowBounds/)

      // The refusal lands only now, after the helper has given up — which is
      // the ordering this is about, and why the rejection is driven by hand
      // rather than scheduled: a timer would make the test wait out a guess.
      refuse(new Error('Protocol error (Browser.setWindowBounds)'))
      await yieldTurns(5)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
