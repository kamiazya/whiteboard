/**
 * The cache that holds the daemon's workspace records, whatever the record is
 * held as. What it promises is about WHEN a handle is given back: never while a
 * bracket is still reading it, once it has left the cache and the last bracket
 * is done, and for a record nobody has used for a while.
 */
import { leaseKind, loadCrdtEngine, type RecordLease } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordCache } from './record-cache.js'

interface Handle {
  readonly name: string
}
const handle = (name: string): Handle => ({ name })

let released: string[]
let locked: Set<string>
let now: number

function cache(options: { maxEntries?: number; idleMs?: number } = {}) {
  return new RecordCache<Handle>({
    maxEntries: options.maxEntries ?? 3,
    idleMs: options.idleMs,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms)
      return { cancel: () => clearTimeout(timer) }
    },
    release: (held) => released.push(held.name),
    pinned: (workspaceId) => locked.has(workspaceId),
    now: () => now,
  })
}

beforeEach(() => {
  released = []
  locked = new Set()
  now = 0
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a handle given back by the bound', () => {
  it('is released at once when no bracket holds it, and is no longer served', () => {
    const records = cache({ maxEntries: 2 })
    records.keep('a', 'wa', handle('a'))
    records.keep('b', 'wb', handle('b'))
    records.keep('c', 'wc', handle('c'))

    expect(released).toEqual(['a'])
    expect(records.get('a')).toBeUndefined()
    expect(records.get('c')?.name).toBe('c')
  })

  it('is released when the last bracket gives it back, not before', () => {
    const records = cache({ maxEntries: 1 })
    records.keep('a', 'wa', handle('a'))
    const lent = records.acquire('a')
    records.keep('b', 'wb', handle('b'))

    expect(records.get('a')).toBeUndefined()
    expect(released).toEqual([])
    lent?.give()
    expect(released).toEqual(['a'])
  })

  it('waits for every bracket that holds it, and is released once', () => {
    const records = cache({ maxEntries: 1 })
    records.keep('a', 'wa', handle('a'))
    const first = records.acquire('a')
    const second = records.acquire('a')
    records.evict('a')

    first?.give()
    expect(released).toEqual([])
    first?.give()
    expect(released).toEqual([])
    second?.give()
    second?.give()
    expect(released).toEqual(['a'])
  })

  it('keeps the least recently used for last, and never drops one whose workspace is locked', () => {
    const records = cache({ maxEntries: 2 })
    records.keep('a', 'wa', handle('a'))
    records.keep('b', 'wb', handle('b'))
    records.get('a')
    locked.add('wb')
    records.keep('c', 'wc', handle('c'))

    // `b` is the least recently used but locked; `a` is next and goes.
    expect(released).toEqual(['a'])
    expect(records.get('b')?.name).toBe('b')
    expect(records.get('c')?.name).toBe('c')
  })
})

describe('a handle replaced or evicted by name', () => {
  it('releases the one a keep replaces, unless it is the same handle', () => {
    const records = cache()
    const same = handle('a')
    records.keep('a', 'wa', same)
    records.keep('a', 'wa', same)
    expect(released).toEqual([])

    records.keep('a', 'wa', handle('a2'))
    expect(released).toEqual(['a'])
  })

  it('releases an evicted handle at once when no bracket holds it', () => {
    const records = cache()
    records.keep('a', 'wa', handle('a'))
    records.evict('a')
    expect(released).toEqual(['a'])
    expect(records.get('a')).toBeUndefined()
  })

  it('releases everything on clear, holding to the ones a bracket still reads', () => {
    const records = cache()
    records.keep('a', 'wa', handle('a'))
    records.keep('b', 'wb', handle('b'))
    const lent = records.acquire('b')
    records.clear()

    expect(released).toEqual(['a'])
    lent?.give()
    expect(released).toEqual(['a', 'b'])
  })
})

describe('a record nobody uses', () => {
  it('is released once it has been idle for the allowed time, and not before', () => {
    const records = cache({ idleMs: 1000 })
    records.keep('a', 'wa', handle('a'))

    now = 999
    vi.advanceTimersByTime(999)
    expect(released).toEqual([])
    now = 1000
    vi.advanceTimersByTime(1)
    expect(released).toEqual(['a'])
    expect(records.get('a')).toBeUndefined()
  })

  it('counts a use as the start of a new wait', () => {
    const records = cache({ idleMs: 1000 })
    records.keep('a', 'wa', handle('a'))
    now = 800
    records.get('a')
    now = 1500
    vi.advanceTimersByTime(1500)
    expect(released).toEqual([])
    now = 1800
    vi.advanceTimersByTime(300)
    expect(released).toEqual(['a'])
  })

  it('is never released while a bracket holds it, and its wait starts when the bracket ends', () => {
    const records = cache({ idleMs: 1000 })
    records.keep('a', 'wa', handle('a'))
    const lent = records.acquire('a')
    now = 5000
    vi.advanceTimersByTime(5000)
    expect(released).toEqual([])

    lent?.give()
    now = 5999
    vi.advanceTimersByTime(999)
    expect(released).toEqual([])
    now = 6000
    vi.advanceTimersByTime(1)
    expect(released).toEqual(['a'])
  })

  it('is kept while its workspace is locked', () => {
    const records = cache({ idleMs: 1000 })
    records.keep('a', 'wa', handle('a'))
    locked.add('wa')
    now = 2000
    vi.advanceTimersByTime(2000)
    expect(released).toEqual([])
    expect(records.get('a')?.name).toBe('a')
  })

  it('arms no timer, and releases nothing, when no idle time is set', () => {
    const records = cache()
    records.keep('a', 'wa', handle('a'))
    now = 10 ** 9
    expect(vi.getTimerCount()).toBe(0)
    expect(records.get('a')?.name).toBe('a')
    expect(released).toEqual([])
  })

  it('arms nothing when it is given no way to wait', () => {
    const records = new RecordCache<Handle>({
      maxEntries: 3,
      idleMs: 1000,
      release: (held) => released.push(held.name),
      pinned: () => false,
      now: () => now,
    })
    records.keep('a', 'wa', handle('a'))
    now = 10_000
    vi.advanceTimersByTime(10_000)
    expect(released).toEqual([])
  })

  it('arms no timer once nothing is left to release', () => {
    const records = cache({ idleMs: 1000 })
    records.keep('a', 'wa', handle('a'))
    now = 1000
    vi.advanceTimersByTime(1000)
    expect(released).toEqual(['a'])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('an engine lease held in it', () => {
  it('stays open for a bracket that outlives its eviction, and is closed when it ends', async () => {
    const engine = await loadCrdtEngine()
    const kind = leaseKind(loadCrdtEngine)
    const lease: RecordLease = await kind.load(
      new Uint8Array(new LoroDoc().export({ mode: 'snapshot' })),
      [],
    )
    const records = new RecordCache<RecordLease>({
      maxEntries: 1,
      release: (held) => held.release(),
      pinned: () => false,
    })
    records.keep('a', 'wa', lease)
    const lent = records.acquire('a')
    records.evict('a')

    // Still readable: the bracket has not given it back.
    expect(() => engine.version({ handle: lease.handle })).not.toThrow()
    lent?.give()
    expect(() => engine.version({ handle: lease.handle })).toThrow()
  })
})

describe('the loans that are out', () => {
  it('counts a loan from the acquire to the give, however the entry is treated meanwhile', () => {
    const records = cache({ maxEntries: 1 })
    records.keep('a', 'wa', handle('a'))
    expect(records.outstanding).toBe(0)

    const first = records.acquire('a')
    const second = records.acquire('a')
    expect(records.outstanding).toBe(2)
    records.evict('a')
    expect(records.outstanding).toBe(2)

    first?.give()
    first?.give()
    expect(records.outstanding).toBe(1)
    second?.give()
    expect(records.outstanding).toBe(0)
  })
})
