import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLayoutCoreHost } from './layout-core.js'
import type { WebCore } from './web-core.js'

const instance = {} as WebCore
/** What a layout draws when the realm's core did not load. */
const CORE_UNAVAILABLE = { code: 'malformed', reason: 'core-unavailable' } as const
/** What a layout draws when the call trapped the core's wasm instance. */
const CORE_TRAPPED = { code: 'malformed', reason: 'core-trapped' } as const

describe('createLayoutCoreHost', () => {
  it('answers no core until the load settles, then the loaded one on every entry, loading once', async () => {
    const load = vi.fn(async () => instance)
    const host = createLayoutCoreHost(load)
    expect(host.current()).toBeUndefined()
    const core = await host.ready()
    expect(core.routing).toBe(instance)
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
  it('has none, and is ready with none', async () => {
    // This test realm installs one at setup, as the page does at boot; a fresh
    // module instance is a realm that never did.
    vi.resetModules()
    const fresh = await import('./layout-core.js')
    expect(fresh.currentLayoutCore()).toBeUndefined()
    expect(await fresh.layoutCoreReady()).toBeUndefined()
    expect(fresh.layoutCoreGeneration()).toBe(0)
  })
})

const trapped = (name: 'CoreInstanceTrapped' | 'CoreUnrecoverable' = 'CoreInstanceTrapped') => {
  const err = new Error('trapped')
  err.name = name
  return err
}

const noHighlight = () => undefined
const noMeasure = () => ({}) as never

describe('a layout that traps the core', () => {
  it.each([
    'layout',
    'markdown',
    'query',
  ] as const)('draws the %s as a refusal for that one call, and answers the next from the core', async (entry) => {
    const calls = { layoutSpatialCanvas: 0, layoutMarkdown: 0, layoutQuery: 0 }
    const answer = { scene: 'drawn' }
    const flaky =
      (name: keyof typeof calls) =>
      (..._args: unknown[]) => {
        calls[name] += 1
        if (calls[name] === 1) throw trapped()
        return answer
      }
    const core = {
      layoutSpatialCanvas: flaky('layoutSpatialCanvas'),
      layoutMarkdown: flaky('layoutMarkdown'),
      layoutQuery: flaky('layoutQuery'),
    } as unknown as WebCore
    const host = createLayoutCoreHost(async () => core)
    const loaded = await host.ready()
    const ask = {
      layout: () => loaded.layout.layoutSpatialCanvas({} as never, noHighlight, noMeasure),
      markdown: () => loaded.markdown.layoutMarkdown({} as never, noHighlight, noMeasure),
      query: () => loaded.query.layoutQuery({} as never, noHighlight, undefined),
    }[entry]
    expect(ask()).toEqual({ refused: CORE_TRAPPED })
    expect(ask()).toBe(answer)
  })

  it('draws an instance that cannot be reset the same way, and lets any other throw through', async () => {
    const core = {
      layoutSpatialCanvas: vi
        .fn()
        .mockImplementationOnce(() => {
          throw trapped('CoreUnrecoverable')
        })
        .mockImplementationOnce(() => {
          throw new TypeError('a defect')
        }),
    } as unknown as WebCore
    const loaded = await createLayoutCoreHost(async () => core).ready()
    const ask = () => loaded.layout.layoutSpatialCanvas({} as never, noHighlight, noMeasure)
    expect(ask()).toEqual({ refused: CORE_TRAPPED })
    expect(ask).toThrow(TypeError)
  })
})

describe('a worker realm over a core that trapped', () => {
  it('lets the trap through for its caller to answer', async () => {
    const core = {
      layoutSpatialCanvas: () => {
        throw trapped()
      },
    } as unknown as WebCore
    const loaded = await createLayoutCoreHost(async () => core, { traps: 'throw' }).ready()
    expect(() => loaded.layout.layoutSpatialCanvas({} as never, noHighlight, noMeasure)).toThrow(
      'trapped',
    )
  })
})
