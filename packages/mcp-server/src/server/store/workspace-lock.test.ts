import { afterEach, describe, expect, it } from 'vitest'
import { _resetWorkspaceLocksForTests, withWorkspaceWriteLock } from './workspace-lock.js'

afterEach(() => {
  _resetWorkspaceLocksForTests()
})

describe('withWorkspaceWriteLock', () => {
  it('serializes critical sections within the same workspace', async () => {
    const events: string[] = []
    const start = (label: string, ms: number) =>
      withWorkspaceWriteLock('ws_a', async () => {
        events.push(`enter-${label}`)
        await new Promise((r) => setTimeout(r, ms))
        events.push(`exit-${label}`)
      })

    await Promise.all([start('first', 30), start('second', 5), start('third', 1)])

    // The whole point: even though "third" is the fastest body, it has
    // to wait until "second" and "first" finish. Order is
    // enter-first, exit-first, enter-second, exit-second, enter-third, exit-third.
    expect(events).toEqual([
      'enter-first',
      'exit-first',
      'enter-second',
      'exit-second',
      'enter-third',
      'exit-third',
    ])
  })

  it('does not block writers on a different workspace', async () => {
    let firstResolve: () => void = () => undefined
    const firstStarted = new Promise<void>((resolve) => {
      firstResolve = resolve
    })
    let releaseFirst: () => void = () => undefined
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const firstPromise = withWorkspaceWriteLock('ws_a', async () => {
      firstResolve()
      await firstHolds
    })
    await firstStarted
    // Even though ws_a's lock is held, ws_b should run immediately.
    let secondRan = false
    const secondPromise = withWorkspaceWriteLock('ws_b', async () => {
      secondRan = true
    })
    await secondPromise
    expect(secondRan).toBe(true)
    releaseFirst()
    await firstPromise
  })

  it('keeps draining the queue after a critical section throws', async () => {
    // A buggy holder that throws must not poison the queue. The next
    // acquirer should still get the lock.
    const events: string[] = []
    const failing = withWorkspaceWriteLock('ws_a', async () => {
      events.push('fail-enter')
      throw new Error('boom')
    }).catch(() => undefined)
    const next = withWorkspaceWriteLock('ws_a', async () => {
      events.push('next-ran')
    })
    await Promise.all([failing, next])
    expect(events).toEqual(['fail-enter', 'next-ran'])
  })

  it('returns the value produced by fn', async () => {
    const result = await withWorkspaceWriteLock('ws_a', async () => 42)
    expect(result).toBe(42)
  })

  it('lets the current holder re-enter the same workspace lock without deadlocking', async () => {
    // A single logical write transaction (e.g. the branches HEAD-switch
    // route) can call something like saveDocument() from within its own
    // already-held critical section. Queueing again would await its own
    // completion and hang forever — the nested call must run immediately.
    const events: string[] = []
    await withWorkspaceWriteLock('ws_reentrant', async () => {
      events.push('outer-enter')
      await withWorkspaceWriteLock('ws_reentrant', async () => {
        events.push('inner-ran')
      })
      events.push('outer-exit')
    })
    expect(events).toEqual(['outer-enter', 'inner-ran', 'outer-exit'])
  })

  it('still serializes a genuinely separate concurrent caller behind the current holder', async () => {
    // Reentrancy detection must not let an UNRELATED concurrent acquirer
    // (different call chain, same workspace) skip the queue — only the
    // current holder's own continuation may bypass it.
    let releaseHolder: () => void = () => undefined
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    const events: string[] = []

    const holderPromise = withWorkspaceWriteLock('ws_b', async () => {
      events.push('holder-enter')
      await holderReleased
      events.push('holder-exit')
    })

    // Give the holder a chance to actually acquire the lock first.
    await new Promise((r) => setTimeout(r, 5))

    let otherSettled = false
    const otherPromise = withWorkspaceWriteLock('ws_b', async () => {
      events.push('other-ran')
    }).then(() => {
      otherSettled = true
    })

    await new Promise((r) => setTimeout(r, 5))
    expect(otherSettled).toBe(false)

    releaseHolder()
    await Promise.all([holderPromise, otherPromise])
    expect(events).toEqual(['holder-enter', 'holder-exit', 'other-ran'])
  })
})
