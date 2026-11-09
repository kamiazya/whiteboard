// The Rust routing core, loaded for real in a browser (ADR-0054 step 5):
// the staged wasm fetched from where the bundler serves it, and a board laid
// out beside the TypeScript with every difference thrown. The jsdom suites
// pin the switch against a fake core; only here does the artifact itself run.
//
// The artifact is built in the pipeline, never committed. Where CI sets
// VITE_WHITEBOARD_CORE a missing artifact FAILS these tests; elsewhere it
// skips and says so, because a person without the Rust toolchain has no
// artifact to load.

import { constantRatioMeasureText, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { okfCodec } from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { LayoutRequest, LayoutResponse } from '../layout-worker-protocol.js'
import { startLayoutCore } from '../page-layout-core.js'
import { createEditorAppearance } from './editor-appearance.js'
import { createLayoutCoreHost, layoutCoreReady } from './layout-core.js'

const REQUIRED = (import.meta.env.VITE_WHITEBOARD_CORE ?? '') !== ''

async function loadRealCore() {
  try {
    // lazy-import: the artifact may be absent, and a static import of the module that names it would fail the whole file to load instead of skipping
    const { loadWebCore } = await import('./layout-core-source.js')
    return { routing: await loadWebCore(fetch) }
  } catch (err) {
    return { failure: err }
  }
}
const real = await loadRealCore()

const silent = () => ({ warn: vi.fn(), debug: vi.fn() })

const board = (routing: 'orthogonal' | 'curved' | 'straight'): SpatialCanvas =>
  ({
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 220, height: 140, text: 'a' }),
      textNode({ id: 'b', x: 420, y: 40, width: 200, height: 120, text: 'b' }),
      textNode({ id: 'c', x: 120, y: 320, width: 240, height: 110, text: 'c' }),
      textNode({ id: 'd', x: 520, y: 360, width: 160, height: 90, text: 'd' }),
      groupNode({ id: 'g', x: -40, y: -40, width: 760, height: 520, label: 'group' }),
    ],
    edges: [
      { id: 'e1', from: { node: 'a' }, to: { node: 'b' }, label: 'ab' },
      { id: 'e2', from: { node: 'b' }, to: { node: 'c' } },
      { id: 'e3', from: { node: 'a' }, to: { node: 'c' } },
      { id: 'e4', from: { node: 'a' }, to: { node: 'd' } },
      { id: 'e5', from: { node: 'c' }, to: { node: 'd' } },
    ],
    facets: { 'visual.edges/v0': { routing } },
  }) as SpatialCanvas

describe('the real Rust core in a browser', () => {
  it.runIf(REQUIRED)('finds the staged artifact where the pipeline promised it', () => {
    if ('failure' in real) throw real.failure
  })

  it.skipIf('failure' in real)(
    'lays boards out beside the TypeScript with no difference, thrown or otherwise',
    async () => {
      if ('failure' in real) return
      const { routing } = real
      let calls = 0
      const host = createLayoutCoreHost(
        { impl: 'differential', okf: 'ts', mismatch: 'throw' },
        async () => ({
          ...routing,
          routeLayout: (...args) => {
            calls += 1
            return routing.routeLayout(...args)
          },
        }),
        silent(),
      )
      const core = await host.ready()
      expect(core).toBeDefined()
      for (const style of ['orthogonal', 'curved', 'straight'] as const) {
        const scene = layoutSpatialCanvas(board(style), {
          measure: constantRatioMeasureText,
          appearance: createEditorAppearance('light'),
          core,
        })
        expect(scene.nodes.length).toBeGreaterThan(0)
      }
      // The core was consulted for every board, so "no difference" compared something.
      expect(calls).toBe(3)
    },
  )
})

describe('the real Rust core reading and writing OKF in a browser', () => {
  it.skipIf('failure' in real)(
    'reads and writes a note beside the TypeScript with no difference, thrown or otherwise',
    async () => {
      if ('failure' in real) return
      const { routing } = real
      let calls = 0
      const host = createLayoutCoreHost(
        { impl: 'ts', okf: 'differential', mismatch: 'throw' },
        async () => ({
          ...routing,
          parseOkf: (text) => {
            calls += 1
            return routing.parseOkf(text)
          },
          serializeOkf: (doc) => {
            calls += 1
            return routing.serializeOkf(doc)
          },
        }),
        silent(),
      )
      await host.ready()
      const codec = okfCodec(host.currentOkf())
      const text = '---\ntype: note\ntitle: Plan\ntags: [a, b]\nweight: -0.0\n---\n# 計画\n\nbody\n'
      const parsed = codec.parseOkf(text)
      if (!parsed.ok) throw new Error(parsed.error.message)
      expect(codec.serializeOkf(parsed.value)).toContain('# 計画')
      expect(codec.parseOkf('---\ntype: [\n---\n').ok).toBe(false)
      // The core was consulted for every call, so "no difference" compared something.
      expect(calls).toBe(3)
    },
  )
})

describe.runIf(REQUIRED)('the page core', () => {
  it('loads although the page has since replaced fetch, which knows nothing of the wasm', async () => {
    startLayoutCore()
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    try {
      expect(await layoutCoreReady()).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe.skipIf(!REQUIRED)('the layout worker with the core on', () => {
  it('lays a board out through its own loaded core without a mismatch', async () => {
    const request: LayoutRequest = {
      type: 'layout',
      id: 1,
      canvas: board('orthogonal'),
      theme: 'light',
    }
    const reply = await new Promise<LayoutResponse>((resolve, reject) => {
      const worker = new Worker(new URL('../layout-worker.ts', import.meta.url), { type: 'module' })
      const timer = setTimeout(() => reject(new Error('layout worker timed out')), 30_000)
      worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
        clearTimeout(timer)
        worker.terminate()
        resolve(e.data)
      }
      worker.onerror = (e) => {
        clearTimeout(timer)
        worker.terminate()
        reject(new Error(`layout worker error: ${e.message}`))
      }
      worker.postMessage(request)
    })
    // A core that failed to load, or a difference, under VITE_WHITEBOARD_CORE_MISMATCH=throw
    // fails the request; `laid-out` is the core having been compared and found equal.
    expect(reply.type).toBe('laid-out')
  }, 60_000)
})
