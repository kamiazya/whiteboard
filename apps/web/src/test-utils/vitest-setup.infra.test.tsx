import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearHookOrderLog, readHookOrderLog, runSharedTestTeardown } from '../../vitest.setup.js'
import { drainSchedulerMacrotasks } from './scheduler-drain.js'

// Proves the guarantees the shared apps/web jsdom teardown hook
// (../../vitest.setup.ts) relies on, rather than assuming them:
//  - a leaked fake-timer state is restored AND reported, never papered over
//  - the macrotask drain is a fixpoint (a second call finds nothing new)
//  - this file's own (and by extension every test file's) per-file/RTL
//    afterEach hooks run before the shared setup-file afterEach's drain
//  - the shared teardown unmounts every RTL tree, so a file that forgets
//    its own cleanup() (vitest globals:false means RTL cannot self-register
//    an afterEach) doesn't leave a mounted component, and its effects'
//    scheduled timers, running into the next test or the file's own teardown

describe('vitest.setup shared teardown', () => {
  it('unmounts RTL trees left mounted by a test that forgot its own cleanup()', async () => {
    render(<div data-testid="leak-probe" />)
    expect(document.body.querySelector('[data-testid="leak-probe"]')).not.toBeNull()

    await runSharedTestTeardown('a test that forgot to call cleanup()')

    expect(document.body.querySelector('[data-testid="leak-probe"]')).toBeNull()
  })

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

  it('unmounts a leaked RTL tree even when the same test also leaks fake timers', async () => {
    render(<div data-testid="leak-probe-both" />)
    vi.useFakeTimers()

    await expect(
      runSharedTestTeardown('a test that forgot both cleanup() and to restore timers'),
    ).rejects.toThrow(/left fake timers active/)

    // cleanup() must run before the fake-timer guard throws, or a file that
    // leaks both never gets its tree torn down.
    expect(document.body.querySelector('[data-testid="leak-probe-both"]')).toBeNull()
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
