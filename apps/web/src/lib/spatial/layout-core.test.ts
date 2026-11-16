import { describe, expect, it, vi } from 'vitest'
import { createLayoutCoreHost, currentLayoutCore, layoutCoreReady } from './layout-core.js'
import type { WebCore } from './web-core.js'

const instance = {} as WebCore

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

  it('rejects a load that fails, throws it to every layout after, and tries again on the next ready', async () => {
    const load = vi
      .fn<() => Promise<WebCore>>()
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce(instance)
    const host = createLayoutCoreHost(load)
    await expect(host.ready()).rejects.toThrow('404')
    // There is no TypeScript to answer in the core's place: a layout after a
    // failed load is an error its surface shows, never a silent fallback.
    expect(() => host.current()).toThrow('404')
    expect((await host.ready()).routing).toBe(instance)
    expect(host.current()?.routing).toBe(instance)
    expect(load).toHaveBeenCalledTimes(2)
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
