import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLayoutCoreHost, currentLayoutCore, layoutCoreReady } from './layout-core.js'
import type { WebCore } from './web-core.js'

const instance = {} as WebCore
/** What a layout draws when the realm's core did not load. */
const CORE_UNAVAILABLE = { code: 'malformed', reason: 'core-unavailable' } as const

describe('createLayoutCoreHost', () => {
  it('answers no core until the load settles, then the loaded one on every entry, loading once', async () => {
    const load = vi.fn(async () => instance)
    const host = createLayoutCoreHost(load)
    expect(host.current()).toBeUndefined()
    const core = await host.ready()
    expect(core).toEqual({
      routing: instance,
      layout: instance,
      markdown: instance,
      query: instance,
    })
    expect(host.current()).toBe(core)
    expect(await host.ready()).toBe(core)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('rejects a load that fails, draws every layout after as the missing-core notice, and tries again on the next ready', async () => {
    const load = vi
      .fn<() => Promise<WebCore>>()
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce(instance)
    const host = createLayoutCoreHost(load)
    await expect(host.ready()).rejects.toThrow('404')
    // There is no TypeScript to answer in the core's place: a layout after a
    // failed load is refused, which each surface draws as its notice.
    const missing = host.current()
    expect(
      missing?.layout.layoutSpatialCanvas(
        {} as never,
        () => undefined,
        () => ({}) as never,
      ),
    ).toEqual({
      refused: CORE_UNAVAILABLE,
    })
    expect(
      missing?.markdown.layoutMarkdown(
        {} as never,
        () => undefined,
        () => ({}) as never,
      ),
    ).toEqual({
      refused: CORE_UNAVAILABLE,
    })
    expect(missing?.query.layoutQuery({} as never, () => undefined, undefined)).toEqual({
      refused: CORE_UNAVAILABLE,
    })
    expect(() =>
      missing?.routing.routeLayout([], [], () => 'straight' as never, undefined, {} as never, []),
    ).toThrow(expect.objectContaining({ name: 'CoreInputRefused' }))
    expect((await host.ready()).routing).toBe(instance)
    expect(host.current()?.routing).toBe(instance)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('a load that never settles', () => {
  afterEach(() => vi.useRealTimers())

  it('is abandoned at the bound, its fetch aborted, so a realm awaiting it carries on', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const host = createLayoutCoreHost(
      (signal) => {
        signals.push(signal)
        return new Promise<WebCore>(() => {})
      },
      { timeoutMs: 30_000 },
    )
    const ready = host.ready()
    const settled = vi.fn()
    ready.then(settled, settled)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(ready).rejects.toMatchObject({ name: 'CoreLoadTimedOut', timeoutMs: 30_000 })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(
      host.current()?.layout.layoutSpatialCanvas(
        {} as never,
        () => undefined,
        () => ({}) as never,
      ),
    ).toEqual({
      refused: CORE_UNAVAILABLE,
    })
  })
})

describe('a layout after a failed load', () => {
  it('asks for the core again once the retry delay has passed, one load at a time, and announces it', async () => {
    let clock = 0
    let settle: (core: WebCore) => void = () => {}
    const load = vi
      .fn<() => Promise<WebCore>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        () =>
          new Promise<WebCore>((resolve) => {
            settle = resolve
          }),
      )
    const host = createLayoutCoreHost(load, { retryAfterMs: 5_000, now: () => clock })
    const heard = vi.fn()
    host.subscribe(heard)
    await expect(host.ready()).rejects.toThrow('offline')
    expect(host.generation()).toBe(0)

    clock = 4_999
    host.current()
    expect(load).toHaveBeenCalledTimes(1)

    clock = 5_000
    host.current()
    host.current()
    // One retry, however many layouts ask while it is in flight.
    expect(load).toHaveBeenCalledTimes(2)

    settle(instance)
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1))
    expect(host.generation()).toBe(1)
    expect(host.current()?.routing).toBe(instance)
  })
})

describe('a failed load, with no layout asking after it', () => {
  afterEach(() => vi.useRealTimers())

  it('retries once by itself after the delay, and announces the core it loads', async () => {
    vi.useFakeTimers()
    const load = vi
      .fn<() => Promise<WebCore>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValue(instance)
    const host = createLayoutCoreHost(load, { retryAfterMs: 5_000 })
    const heard = vi.fn()
    host.subscribe(heard)
    await expect(host.ready()).rejects.toThrow('offline')

    await vi.advanceTimersByTimeAsync(4_999)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)
    // One scheduled retry, not a loop: past it, only a layout asks again.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(2)
    expect(heard).not.toHaveBeenCalled()

    host.current()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(3)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(host.current()?.routing).toBe(instance)
  })

  it('heals a board that drew the notice once, when the scheduled retry loads', async () => {
    vi.useFakeTimers()
    const load = vi
      .fn<() => Promise<WebCore>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(instance)
    const host = createLayoutCoreHost(load, { retryAfterMs: 5_000 })
    const heard = vi.fn()
    host.subscribe(heard)
    await expect(host.ready()).rejects.toThrow('offline')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(host.generation()).toBe(1)
  })
})

describe('the codecs half of the host', () => {
  it('loads for the codecs alone', async () => {
    const load = vi.fn(async () => instance)
    const host = createLayoutCoreHost(load)
    expect(load).not.toHaveBeenCalled()
    expect(await host.codecs()).toBe(instance)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shares the one load the layouts made', async () => {
    const load = vi.fn(async () => instance)
    const host = createLayoutCoreHost(load)
    await host.ready()
    expect(await host.codecs()).toBe(instance)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('rejects when the artifact cannot load, and tries again on the next ask', async () => {
    const load = vi
      .fn<() => Promise<WebCore>>()
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce(instance)
    const host = createLayoutCoreHost(load)
    await expect(host.codecs()).rejects.toThrow('404')
    expect(await host.codecs()).toBe(instance)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('a realm that never installed a core', () => {
  it('has none, and its layouts are the TypeScript composer’s', async () => {
    expect(currentLayoutCore()).toBeUndefined()
    expect(await layoutCoreReady()).toBeUndefined()
  })
})
