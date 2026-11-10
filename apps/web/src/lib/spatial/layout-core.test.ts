import type { CoreMismatch } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it, vi } from 'vitest'
import { createLayoutCoreHost, currentLayoutCore, layoutCoreReady } from './layout-core.js'
import type { CoreSettings } from './layout-core-settings.js'
import type { WebCore } from './web-core.js'

const routing = {} as WebCore
const settings = (
  impl: CoreSettings['impl'],
  mismatch: CoreSettings['mismatch'] = 'log',
): CoreSettings => ({ impl, mismatch })
const silent = () => ({ warn: vi.fn(), debug: vi.fn() })

const differs: CoreMismatch = {
  fn: 'routeLayout',
  kind: 'differs',
  at: 3,
  ts: [1, 2, 3, 4],
  rust: [1, 2, 3, 5],
  repro: {
    nodes: [],
    edges: [],
    styles: [],
    overrides: undefined,
    budget: {} as never,
    labels: [],
  },
}

describe('createLayoutCoreHost', () => {
  it('loads nothing under ts and answers no core', async () => {
    const load = vi.fn(async () => routing)
    const host = createLayoutCoreHost(settings('ts'), load, silent())
    expect(await host.ready()).toBeUndefined()
    expect(host.current()).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })

  it('answers no core until the load settles, then the loaded one, loading once', async () => {
    const load = vi.fn(async () => routing)
    const host = createLayoutCoreHost(settings('differential'), load, silent())
    expect(host.current()).toBeUndefined()
    const core = await host.ready()
    expect(core?.routing).toBe(routing)
    expect(core?.impl).toEqual({ routeLayout: 'differential' })
    expect(host.current()).toBe(core)
    await host.ready()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('carries the impl it was set to', async () => {
    const host = createLayoutCoreHost(settings('rust'), async () => routing, silent())
    expect((await host.ready())?.impl.routeLayout).toBe('rust')
  })

  it('warns and routes in TypeScript when the artifact cannot load', async () => {
    const log = silent()
    const host = createLayoutCoreHost(
      settings('differential'),
      async () => {
        throw new Error('404')
      },
      log,
    )
    expect(await host.ready()).toBeUndefined()
    expect(host.current()).toBeUndefined()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('fails instead when mismatches throw, because nothing was compared', async () => {
    const host = createLayoutCoreHost(
      settings('differential', 'throw'),
      async () => {
        throw new Error('404')
      },
      silent(),
    )
    await expect(host.ready()).rejects.toThrow('404')
    expect(() => host.current()).toThrow('404')
  })

  it('logs a mismatch and carries on under log', async () => {
    const log = silent()
    const host = createLayoutCoreHost(settings('differential'), async () => routing, log)
    const core = await host.ready()
    expect(() => core?.onMismatch?.(differs)).not.toThrow()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('throws a mismatch under throw, naming what differed', async () => {
    const host = createLayoutCoreHost(
      settings('differential', 'throw'),
      async () => routing,
      silent(),
    )
    const core = await host.ready()
    expect(() => core?.onMismatch?.(differs)).toThrow(/differs/)
  })
})

describe('the codecs half of the host', () => {
  it('loads for the codecs alone, and answers no routing core while routing stays on ts', async () => {
    const load = vi.fn(async () => routing)
    const host = createLayoutCoreHost(settings('ts'), load, silent())
    expect(load).not.toHaveBeenCalled()
    expect(await host.codecs()).toBe(routing)
    expect(await host.ready()).toBeUndefined()
    expect(host.current()).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shares the one load routing made', async () => {
    const load = vi.fn(async () => routing)
    const host = createLayoutCoreHost(settings('rust'), load, silent())
    await host.ready()
    expect(await host.codecs()).toBe(routing)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('rejects when the artifact cannot load, whatever routing does, and tries again on the next ask', async () => {
    const load = vi
      .fn<() => Promise<WebCore>>()
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce(routing)
    const host = createLayoutCoreHost(settings('ts'), load, silent())
    await expect(host.codecs()).rejects.toThrow('404')
    expect(await host.codecs()).toBe(routing)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('a realm that never installed a core', () => {
  it('has none and routes in TypeScript', async () => {
    expect(currentLayoutCore()).toBeUndefined()
    expect(await layoutCoreReady()).toBeUndefined()
  })
})
