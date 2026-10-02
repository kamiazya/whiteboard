import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileGcSweeper } from './file-gc-sweeper.js'

describe('file-GC sweeper stop() with no pass in flight', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('still resolves promptly via timeoutMs when there is no in-flight pass to wait for', async () => {
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [],
      discoverFsWorkspaces: async () => [],
      purge,
    })

    // Settled without the clock moving: it did not wait out `timeoutMs`, and
    // no race timer was armed for it to leak.
    let settled = false
    const stopPromise = sweeper.stop({ timeoutMs: 5000 }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(purge).not.toHaveBeenCalled()
    await stopPromise
  })
})
