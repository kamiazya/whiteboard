// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { createUpdateApplier, SWAP_DEADLINE_MS } from './apply-update.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createUpdateApplier', () => {
  it('asks the waiting worker to take over straight away', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn()

    await createUpdateApplier({ apply, recover })()

    expect(apply).toHaveBeenCalledTimes(1)
    expect(recover).not.toHaveBeenCalled()
  })

  // A swap that lands reloads the page, which discards this timer with it. A
  // timer that fires therefore means the browser never activated the worker —
  // and it will not for minutes, however many times it is asked again.
  it('falls back to a fresh reload when the page is still here after the deadline', async () => {
    const recover = vi.fn()
    await createUpdateApplier({ apply: () => Promise.resolve(), recover })()

    await vi.advanceTimersByTimeAsync(SWAP_DEADLINE_MS - 1)
    expect(recover).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(recover).toHaveBeenCalledTimes(1)
    await expectLoggedFailure('did not take over')
  })

  it('arms one deadline however many times the update is applied', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn()
    const applyUpdate = createUpdateApplier({ apply, recover })

    await applyUpdate()
    await vi.advanceTimersByTimeAsync(SWAP_DEADLINE_MS / 2)
    await applyUpdate()
    await vi.advanceTimersByTimeAsync(SWAP_DEADLINE_MS)

    expect(apply).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledTimes(1)
    await expectLoggedFailure('did not take over')
  })

  // Nothing was waiting, so a reload would discard the user's page for no update.
  it('does not reload when applying itself fails', async () => {
    const recover = vi.fn()
    const applyUpdate = createUpdateApplier({
      apply: () => Promise.reject(new Error('no waiting worker')),
      recover,
    })

    await expect(applyUpdate()).rejects.toThrow('no waiting worker')
    await vi.advanceTimersByTimeAsync(SWAP_DEADLINE_MS * 2)

    expect(recover).not.toHaveBeenCalled()
  })

  it('arms a new deadline for an apply made after one has fired', async () => {
    const recover = vi.fn()
    const applyUpdate = createUpdateApplier({ apply: () => Promise.resolve(), recover })

    await applyUpdate()
    await vi.advanceTimersByTimeAsync(SWAP_DEADLINE_MS)
    await applyUpdate()
    await vi.advanceTimersByTimeAsync(SWAP_DEADLINE_MS)

    expect(recover).toHaveBeenCalledTimes(2)
    await expectLoggedFailure('did not take over')
  })
})

// The suite above advances by the exported SWAP_DEADLINE_MS, so the value is
// free to drift; the recovery exists because the browser's own ceiling is five
// minutes, so a deadline anywhere near that is no recovery at all.
describe('createUpdateApplier with its default deadline', () => {
  it('recovers a lost swap within ten seconds, not before', async () => {
    const recover = vi.fn()
    await createUpdateApplier({ apply: () => Promise.resolve(), recover })()

    await vi.advanceTimersByTimeAsync(9_999)
    expect(recover).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recover).toHaveBeenCalledTimes(1)
    await expectLoggedFailure('did not take over')
  })
})

// A failed apply disarms its deadline, and the next apply has to arm a fresh
// one: otherwise a swap the browser then loses is never recovered.
describe('createUpdateApplier: an apply after a failed one', () => {
  it('arms its own deadline, so a swap the browser then loses is still recovered', async () => {
    const recover = vi.fn()
    const apply = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('no waiting worker'))
      .mockResolvedValue(undefined)
    const applyUpdate = createUpdateApplier({ apply, recover })

    await expect(applyUpdate()).rejects.toThrow('no waiting worker')
    await applyUpdate()
    await vi.advanceTimersByTimeAsync(SWAP_DEADLINE_MS)

    expect(recover).toHaveBeenCalledTimes(1)
    await expectLoggedFailure('did not take over')
  })
})
