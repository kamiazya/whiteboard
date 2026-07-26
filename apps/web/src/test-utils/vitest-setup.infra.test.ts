import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearHookOrderLog, readHookOrderLog, runSharedTestTeardown } from '../../vitest.setup.js'
import { drainSchedulerMacrotasks } from './scheduler-drain.js'

// Proves the guarantees the shared apps/web jsdom teardown hook
// (../../vitest.setup.ts) relies on, rather than assuming them:
//  - a leaked fake-timer state is restored AND reported, never papered over
//  - the macrotask drain is a fixpoint (a second call finds nothing new)
//  - this file's own (and by extension every test file's) per-file/RTL
//    afterEach hooks run before the shared setup-file afterEach's drain

describe('vitest.setup shared teardown', () => {
  it('drain is a fixpoint: a second drain observes no newly-scheduled work', async () => {
    let ticks = 0
    setImmediate(() => {
      ticks += 1
    })
    await drainSchedulerMacrotasks()
    expect(ticks).toBe(1)

    await drainSchedulerMacrotasks()
    expect(ticks).toBe(1)
  })

  it('restores real timers non-silently when a test leaves fake timers active', async () => {
    vi.useFakeTimers()
    expect(vi.isFakeTimers()).toBe(true)

    await expect(runSharedTestTeardown('a test that forgot to restore timers')).rejects.toThrow(
      /left fake timers active/,
    )

    // Reported loudly (rejected), but still restored for whatever runs next.
    expect(vi.isFakeTimers()).toBe(false)
  })

  describe('hook ordering', () => {
    afterEach(() => {
      readHookOrderLog().push('local-describe-afterEach')
    })

    it('seeds a clean log before the ordering assertion runs', () => {
      clearHookOrderLog()
    })

    it('observes the local afterEach ran before the shared setup-file afterEach', () => {
      // Populated by the previous test's teardown: its own describe-scoped
      // afterEach above, then the real shared afterEach registered in
      // vitest.setup.ts (via recordSharedAfterEachRan()).
      expect(readHookOrderLog()).toEqual(['local-describe-afterEach', 'shared-setup-afterEach'])
    })
  })
})
