// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncWriteRefusedError } from './api-contracts/sync-write-refusal.js'
import { flush } from './test-utils/flush.js'
import {
  retryAfterMsOf,
  retryDelayMs,
  SyncWriteFailedError,
  WriteChain,
  type WriteChainOptions,
} from './write-chain.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('retryDelayMs', () => {
  it('doubles from one second and holds at thirty', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelayMs(n))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
    ])
  })

  it('waits at least as long as the daemon asked, up to the ceiling', () => {
    expect(retryDelayMs(1, 5000)).toBe(5000)
    expect(retryDelayMs(4, 5000)).toBe(8000)
    expect(retryDelayMs(1, 120_000)).toBe(30_000)
  })
})

describe('retryAfterMsOf', () => {
  it('reads delay-seconds and an HTTP-date, and nothing else', () => {
    expect(retryAfterMsOf('3')).toBe(3000)
    expect(retryAfterMsOf('Wed, 21 Oct 2015 07:28:10 GMT', Date.UTC(2015, 9, 21, 7, 28, 0))).toBe(
      10_000,
    )
    expect(retryAfterMsOf('soon')).toBeNull()
    expect(retryAfterMsOf(null)).toBeNull()
  })
})

/** A document whose state is a counter: the mark is the count a write covers. */
function counterChain(push: (bytes: Uint8Array) => Promise<void>) {
  let state = 0
  let acked = 0
  const events: string[] = []
  const options: WriteChainOptions<number> = {
    outstanding: () => (state === acked ? null : { mark: state, bytes: new Uint8Array([state]) }),
    acknowledge: (mark) => {
      acked = mark
    },
    push,
    onFailing: () => events.push('failing'),
    onLanded: () => events.push('landed'),
    onRefused: (refusal, wasFailing) => events.push(`refused:${refusal.code}:${wasFailing}`),
  }
  const chain = new WriteChain(options)
  return {
    chain,
    events,
    edit: () => {
      state += 1
      chain.schedule()
    },
    acked: () => acked,
  }
}

describe('WriteChain', () => {
  it('does not acknowledge an edit made while the write covering an earlier one was in flight', async () => {
    let release: () => void = () => {}
    const pushes: number[] = []
    const c = counterChain((bytes) => {
      pushes.push(bytes[0] ?? -1)
      return new Promise((resolve) => {
        release = resolve
      })
    })
    c.edit()
    await flush()
    c.edit()
    release()
    await flush()
    expect(c.acked()).toBe(1)
    release()
    await flush()
    expect(pushes).toEqual([1, 2])
    expect(c.acked()).toBe(2)
  })

  it('retries a failed write on its own and says when it landed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let fail = true
    const c = counterChain(async () => {
      if (fail) throw new SyncWriteFailedError(503, null)
    })
    c.edit()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.events).toEqual(['failing'])
    fail = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.events).toEqual(['failing', 'landed'])
    expect(c.acked()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('writes nothing after a refusal until it is resumed', async () => {
    let refuse = true
    const pushes: number[] = []
    const c = counterChain(async (bytes) => {
      pushes.push(bytes[0] ?? -1)
      if (refuse) throw new SyncWriteRefusedError(413, { code: null, message: 'too big' })
    })
    c.edit()
    await flush()
    c.edit()
    await flush()
    expect(pushes).toEqual([1])
    expect(c.events).toEqual(['refused:null:false'])
    expect(c.chain.failing).toBe(true)

    refuse = false
    c.chain.resume()
    expect(c.chain.failing).toBe(false)
    c.edit()
    await flush()
    expect(pushes).toEqual([1, 3])
    expect(c.acked()).toBe(3)
  })

  it('stops retrying once closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let pushes = 0
    const c = counterChain(async () => {
      pushes += 1
      throw new SyncWriteFailedError(503, null)
    })
    c.edit()
    await vi.advanceTimersByTimeAsync(0)
    c.chain.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pushes).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
