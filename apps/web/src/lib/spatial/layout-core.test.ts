import type { CoreMismatch } from '@kamiazya/whiteboard-canvas-render'
import { okfCodec } from '@kamiazya/whiteboard-codec'
import { describe, expect, it, vi } from 'vitest'
import { currentOkfCodec } from '../okf-codec.js'
import { createLayoutCoreHost, currentLayoutCore, layoutCoreReady } from './layout-core.js'
import type { CoreSettings } from './layout-core-settings.js'
import type { WebCore } from './web-core.js'

const routing = {} as WebCore
const settings = (
  impl: CoreSettings['impl'],
  mismatch: CoreSettings['mismatch'] = 'log',
  okf: CoreSettings['okf'] = 'ts',
): CoreSettings => ({ impl, okf, mismatch })
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

describe('the OKF half of the host', () => {
  it('loads for OKF alone, and answers no routing core while routing stays on ts', async () => {
    const load = vi.fn(async () => routing)
    const host = createLayoutCoreHost(settings('ts', 'log', 'differential'), load, silent())
    expect(host.currentOkf()).toBeUndefined()
    expect(await host.ready()).toBeUndefined()
    expect(host.current()).toBeUndefined()
    const okf = host.currentOkf()
    expect(okf?.okf).toBe(routing)
    expect(okf?.impl).toEqual({ parseOkf: 'differential', serializeOkf: 'differential' })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('answers no OKF core while OKF stays on ts, from the one load routing made', async () => {
    const load = vi.fn(async () => routing)
    const host = createLayoutCoreHost(settings('rust'), load, silent())
    await host.ready()
    expect(host.currentOkf()).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('throws an OKF difference under throw and logs it under log', async () => {
    const differsOkf = {
      fn: 'parseOkf' as const,
      kind: 'differs' as const,
      ts: 'a',
      rust: 'b',
      text: '',
    }
    const strict = createLayoutCoreHost(
      settings('ts', 'throw', 'differential'),
      async () => routing,
      silent(),
    )
    await strict.ready()
    expect(() => strict.currentOkf()?.onMismatch?.(differsOkf)).toThrow(/OKF core differs/)
    const log = silent()
    const lenient = createLayoutCoreHost(settings('ts', 'log', 'rust'), async () => routing, log)
    await lenient.ready()
    lenient.currentOkf()?.onMismatch?.(differsOkf)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  describe('a declined OKF call', () => {
    const declined = {
      fn: 'parseOkf' as const,
      kind: 'declined' as const,
      err: new Error('refused: input-too-large'),
    }

    it('fails like a difference under throw', async () => {
      const strict = createLayoutCoreHost(
        settings('ts', 'throw', 'differential'),
        async () => routing,
        silent(),
      )
      await strict.ready()
      expect(() => strict.currentOkf()?.onMismatch?.(declined)).toThrow(
        /OKF core declined: .*"fn":"parseOkf".*input-too-large/,
      )
    })

    it('is logged as an okf-declined record with its reason and no content otherwise', async () => {
      const log = silent()
      const lenient = createLayoutCoreHost(settings('ts', 'log', 'rust'), async () => routing, log)
      await lenient.ready()
      lenient.currentOkf()?.onMismatch?.(declined)
      expect(log.warn).toHaveBeenCalledWith('the Rust core declined; answered in TypeScript', {
        event: 'okf-declined',
        fn: 'parseOkf',
        reason: 'Error: refused: input-too-large',
      })
      expect(log.debug).not.toHaveBeenCalled()
    })
  })
})

describe('a realm that never installed a core', () => {
  it('has none and routes in TypeScript', async () => {
    expect(currentLayoutCore()).toBeUndefined()
    expect(await layoutCoreReady()).toBeUndefined()
  })

  it('reads and writes OKF in the TypeScript', () => {
    const text = '---\ntype: note\n---\nbody\n'
    expect(currentOkfCodec().parseOkf(text)).toEqual(okfCodec(undefined).parseOkf(text))
  })
})
