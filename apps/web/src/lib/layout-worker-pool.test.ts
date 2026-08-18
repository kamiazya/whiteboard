import { describe, expect, it } from 'vitest'
import { createLayoutWorkerPool, type PoolWorker } from './layout-worker-pool.js'

/**
 * A worker whose replies the test releases by hand, so "how many ran at
 * once" is an observation rather than a race.
 */
function fakeWorkerFactory() {
  const live: FakeWorker[] = []

  class FakeWorker implements PoolWorker {
    onmessage: ((event: { data: { id: number } }) => void) | null = null
    // A real Worker carries this on its prototype, so the pool's feature
    // check sees it; a fake that omits the field silently never gets wired.
    onerror: ((event: unknown) => void) | null = null
    readonly sent: number[] = []
    terminated = false

    postMessage(request: { id: number }) {
      this.sent.push(request.id)
    }
    terminate() {
      this.terminated = true
    }
    /** Reply to the request this worker is holding. */
    reply(id: number, payload: Record<string, unknown> = {}) {
      this.onmessage?.({ data: { id, ...payload } })
    }
    get inFlight() {
      return this.sent.length
    }
  }

  return {
    create: () => {
      const worker = new FakeWorker()
      live.push(worker)
      return worker
    },
    live,
  }
}

/**
 * A request the test starts but never awaits still rejects when the pool is
 * cancelled or disposed. Without a handler vitest reports it as an unhandled
 * rejection, and a genuine one would be lost in the noise.
 */
function ignore(promise: Promise<unknown>): void {
  void promise.catch(() => undefined)
}

describe('createLayoutWorkerPool', () => {
  // The point of a pool: N documents in a list render at once instead of
  // queueing behind one worker the way the editor's single worker does.
  it('spreads concurrent requests across workers instead of serialising them', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 3, createWorker: factory.create })

    const a = pool.run({ id: 1 })
    const b = pool.run({ id: 2 })
    const c = pool.run({ id: 3 })

    expect(factory.live).toHaveLength(3)
    expect(factory.live.map((w) => w.inFlight)).toEqual([1, 1, 1])

    factory.live[0].reply(1, { ok: 'a' })
    factory.live[1].reply(2, { ok: 'b' })
    factory.live[2].reply(3, { ok: 'c' })
    await expect(Promise.all([a, b, c])).resolves.toEqual([
      { id: 1, ok: 'a' },
      { id: 2, ok: 'b' },
      { id: 3, ok: 'c' },
    ])
    pool.dispose()
  })

  it('never creates more workers than its size, queueing the rest', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 2, createWorker: factory.create })

    const first = pool.run({ id: 1 })
    ignore(pool.run({ id: 2 }))
    const third = pool.run({ id: 3 })

    expect(factory.live).toHaveLength(2)
    // The third waits rather than spawning a worker or piling onto a busy one.
    expect(factory.live.map((w) => w.inFlight)).toEqual([1, 1])

    factory.live[0].reply(1, { ok: 'a' })
    await first
    expect(factory.live[0].inFlight).toBe(2)
    factory.live[0].reply(3, { ok: 'c' })
    await expect(third).resolves.toEqual({ id: 3, ok: 'c' })
    pool.dispose()
  })

  // A list scrolls: the row that left the viewport must stop occupying a
  // worker slot the visible rows are waiting for.
  it('drops a cancelled request without ever sending it', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 1, createWorker: factory.create })

    const first = pool.run({ id: 1 })
    const queued = pool.run({ id: 2 })
    const after = pool.run({ id: 3 })
    pool.cancel(2)

    factory.live[0].reply(1, { ok: 'a' })
    await first

    expect(factory.live[0].sent).toEqual([1, 3])
    await expect(queued).rejects.toThrow(/cancelled/i)
    factory.live[0].reply(3, { ok: 'c' })
    await expect(after).resolves.toEqual({ id: 3, ok: 'c' })
    pool.dispose()
  })

  it('frees the slot when a worker replies to something already cancelled', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 1, createWorker: factory.create })

    const running = pool.run({ id: 1 })
    pool.cancel(1)
    await expect(running).rejects.toThrow(/cancelled/i)

    // The in-flight reply still arrives; the slot must come back rather than
    // stranding the pool with a worker it thinks is busy forever.
    factory.live[0].reply(1, { ok: 'late' })
    const next = pool.run({ id: 2 })
    expect(factory.live[0].sent).toEqual([1, 2])
    factory.live[0].reply(2, { ok: 'b' })
    await expect(next).resolves.toEqual({ id: 2, ok: 'b' })
    pool.dispose()
  })

  // The order that matters and the one the test above misses: a worker keeps
  // running a cancelled request, so its stale reply can land AFTER the freed
  // slot has been handed a new one. Treating that reply as this slot's
  // outcome strands the new request forever.
  it('does not strand the request that took a cancelled one’s slot', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 1, createWorker: factory.create })

    const abandoned = pool.run({ id: 1 })
    pool.cancel(1)
    await expect(abandoned).rejects.toThrow(/cancelled/i)

    const replacement = pool.run({ id: 2 })
    expect(factory.live[0].sent).toEqual([1, 2])

    // The cancelled request's reply arrives first, as it must — nothing can
    // un-send it.
    factory.live[0].reply(1, { ok: 'stale' })
    factory.live[0].reply(2, { ok: 'wanted' })

    await expect(replacement).resolves.toEqual({ id: 2, ok: 'wanted' })
    pool.dispose()
  })

  it('creates workers lazily, so an unused pool costs nothing', () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 4, createWorker: factory.create })
    expect(factory.live).toHaveLength(0)
    pool.dispose()
  })

  it('terminates every worker on dispose', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 2, createWorker: factory.create })
    ignore(pool.run({ id: 1 }))
    ignore(pool.run({ id: 2 }))

    pool.dispose()

    expect(factory.live.map((w) => w.terminated)).toEqual([true, true])
  })

  it('clamps a nonsense size rather than spawning unbounded workers', () => {
    const factory = fakeWorkerFactory()
    for (const size of [0, -3, Number.NaN]) {
      const pool = createLayoutWorkerPool({ size, createWorker: factory.create })
      ignore(pool.run({ id: 1 }))
      ignore(pool.run({ id: 2 }))
      expect(factory.live.length).toBeGreaterThanOrEqual(1)
      pool.dispose()
      factory.live.length = 0
    }
  })

  // The editor and a thumbnail list share the fleet, so the ordering rule is
  // what keeps a background list from sitting in front of the commit a user
  // just made — the one latency that is actually felt.
  it('serves an interactive request before background work already queued', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 1, createWorker: factory.create })

    const running = pool.run({ id: 1 }, 'background')
    ignore(pool.run({ id: 2 }, 'background'))
    ignore(pool.run({ id: 3 }, 'background'))
    ignore(pool.run({ id: 4 }, 'interactive'))

    factory.live[0].reply(1, {})
    await running

    // 4 jumps the two background requests that were queued before it.
    expect(factory.live[0].sent).toEqual([1, 4])
    pool.dispose()
  })

  it('keeps FIFO within one priority', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 1, createWorker: factory.create })

    const running = pool.run({ id: 1 }, 'interactive')
    ignore(pool.run({ id: 2 }, 'interactive'))
    ignore(pool.run({ id: 3 }, 'interactive'))

    factory.live[0].reply(1, {})
    await running

    expect(factory.live[0].sent).toEqual([1, 2])
    pool.dispose()
  })

  // Ordering alone is not enough: a worker cannot be interrupted mid-message,
  // so background work filling every slot would still make an interactive
  // request wait out a render it never cared about.
  it('leaves a slot free for interactive work rather than filling every worker with background', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 3, createWorker: factory.create })

    ignore(pool.run({ id: 1 }, 'background'))
    ignore(pool.run({ id: 2 }, 'background'))
    ignore(pool.run({ id: 3 }, 'background'))

    // Only two of the three workers are handed background work.
    expect(factory.live.filter((w) => w.inFlight > 0)).toHaveLength(2)

    ignore(pool.run({ id: 9 }, 'interactive'))
    expect(factory.live.some((w) => w.sent.includes(9))).toBe(true)
    pool.dispose()
  })

  // A single-worker machine has no slot to reserve; background still runs
  // rather than starving, and an interactive request waits out at most one
  // render instead of the whole list.
  it('still runs background work when the fleet is a single worker', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 1, createWorker: factory.create })

    const only = pool.run({ id: 1 }, 'background')
    expect(factory.live[0].sent).toEqual([1])
    factory.live[0].reply(1, { ok: true })
    await expect(only).resolves.toEqual({ id: 1, ok: true })
    pool.dispose()
  })

  it('defaults to interactive, so an unlabelled caller is never deprioritised', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 1, createWorker: factory.create })

    const running = pool.run({ id: 1 }, 'background')
    ignore(pool.run({ id: 2 }, 'background'))
    ignore(pool.run({ id: 3 }))

    factory.live[0].reply(1, {})
    await running

    expect(factory.live[0].sent).toEqual([1, 3])
    pool.dispose()
  })

  it('rejects the in-flight request when its worker errors', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 1, createWorker: factory.create })
    const running = pool.run({ id: 1 })

    factory.live[0].onerror?.(new Event('error'))

    await expect(running).rejects.toThrow()
    pool.dispose()
  })

  it('rejects everything still pending when the pool is disposed', async () => {
    const factory = fakeWorkerFactory()
    const pool = createLayoutWorkerPool({ size: 1, createWorker: factory.create })
    const running = pool.run({ id: 1 })
    const queued = pool.run({ id: 2 })

    pool.dispose()

    await expect(running).rejects.toThrow(/disposed/i)
    await expect(queued).rejects.toThrow(/disposed/i)
  })
})

describe('pool sizing', () => {
  it('leaves a core for the main thread and caps the fleet', async () => {
    const { defaultPoolSize } = await import('./layout-worker-pool.js')
    // A thumbnail list is not worth every core: the editor's own worker and
    // the main thread still have to run while it fills.
    expect(defaultPoolSize(1)).toBe(1)
    expect(defaultPoolSize(4)).toBe(3)
    expect(defaultPoolSize(32)).toBe(4)
    expect(defaultPoolSize(undefined)).toBe(2)
  })
})

// A dispatch bug that only shows up under real postMessage ordering escapes
// the fakes above — one did, stranding the request that took a cancelled
// one's slot. The end-to-end path lives in
// markdown-editor/rail-write-mode.browser.test.tsx, where a real worker lays
// out a real document.
