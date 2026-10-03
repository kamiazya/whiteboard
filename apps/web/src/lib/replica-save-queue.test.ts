import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { createReplicaSaveQueue, type ReplicaSaveHealth } from './replica-save-queue.js'

describe('createReplicaSaveQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(save: (record: string) => Promise<void>) {
    const health: ReplicaSaveHealth[] = []
    const queue = createReplicaSaveQueue<string>({
      save,
      onHealth: (next) => health.push(next),
      debounceMs: 100,
    })
    return { queue, health }
  }

  it('coalesces a burst into one save of the latest record', async () => {
    const save = vi.fn<(record: string) => Promise<void>>().mockResolvedValue(undefined)
    const { queue, health } = setup(save)
    queue.schedule('a')
    queue.schedule('b')
    await vi.advanceTimersByTimeAsync(100)
    expect(save.mock.calls).toEqual([['b']])
    expect(health).toEqual(['ok'])
  })

  it('flush takes a waiting save now, and does nothing when none waits', async () => {
    const save = vi.fn<(record: string) => Promise<void>>().mockResolvedValue(undefined)
    const { queue } = setup(save)
    queue.flush()
    expect(save).not.toHaveBeenCalled()
    queue.schedule('a')
    queue.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(save.mock.calls).toEqual([['a']])
    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('reports a refused save, logs it, and keeps going so a later save can land', async () => {
    const save = vi
      .fn<(record: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('QuotaExceededError'))
      .mockResolvedValue(undefined)
    const { queue, health } = setup(save)
    queue.schedule('a')
    await vi.advanceTimersByTimeAsync(100)
    expect(health).toEqual(['failed'])
    await expectLoggedFailure('replica save failed')

    queue.schedule('b')
    await vi.advanceTimersByTimeAsync(100)
    expect(health).toEqual(['failed', 'ok'])
  })

  it('retry saves the latest record again without waiting out the debounce', async () => {
    const save = vi
      .fn<(record: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('QuotaExceededError'))
      .mockResolvedValue(undefined)
    const { queue, health } = setup(save)
    queue.schedule('a')
    await vi.advanceTimersByTimeAsync(100)
    await expectLoggedFailure('replica save failed')
    queue.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(save.mock.calls).toEqual([['a'], ['a']])
    expect(health).toEqual(['failed', 'ok'])
  })

  it('runs saves one at a time, in order', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const save = vi.fn(async (record: string) => {
      order.push(`start ${record}`)
      if (record === 'a') await new Promise<void>((resolve) => (release = resolve))
      order.push(`end ${record}`)
    })
    const { queue } = setup(save)
    queue.schedule('a')
    await vi.advanceTimersByTimeAsync(100)
    queue.schedule('b')
    await vi.advanceTimersByTimeAsync(100)
    expect(order).toEqual(['start a'])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('with no debounce given, waits half a second of quiet before saving', async () => {
    const save = vi.fn<(record: string) => Promise<void>>().mockResolvedValue(undefined)
    const queue = createReplicaSaveQueue<string>({ save, onHealth: () => undefined })
    queue.schedule('a')

    await vi.advanceTimersByTimeAsync(499)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(save.mock.calls).toEqual([['a']])
  })

  it('restarts the quiet window on every schedule', async () => {
    const save = vi.fn<(record: string) => Promise<void>>().mockResolvedValue(undefined)
    const { queue } = setup(save)
    queue.schedule('a')
    await vi.advanceTimersByTimeAsync(99)
    queue.schedule('b')
    await vi.advanceTimersByTimeAsync(99)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(save.mock.calls).toEqual([['b']])
  })

  it('flush after the save has landed saves nothing again', async () => {
    const save = vi.fn<(record: string) => Promise<void>>().mockResolvedValue(undefined)
    const { queue } = setup(save)
    queue.schedule('a')
    await vi.advanceTimersByTimeAsync(100)

    queue.flush()
    await vi.advanceTimersByTimeAsync(0)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('retry takes the save now and cancels the one still waiting, so the record is saved once', async () => {
    const save = vi.fn<(record: string) => Promise<void>>().mockResolvedValue(undefined)
    const { queue } = setup(save)
    queue.schedule('a')

    queue.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(save.mock.calls).toEqual([['a']])

    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('retry with nothing ever scheduled saves nothing', async () => {
    const save = vi.fn<(record: string) => Promise<void>>().mockResolvedValue(undefined)
    const { queue } = setup(save)

    queue.retry()
    await vi.advanceTimersByTimeAsync(0)

    expect(save).not.toHaveBeenCalled()
  })
})
