// The Rust core, loaded for real in a browser (ADR-0054): the staged wasm
// fetched from where the bundler serves it, and a board laid out through it
// as the TypeScript composer lays it out. The jsdom suites pin the host
// against a fake core; only here does the artifact itself run.
//
// The artifact is built in the pipeline, never committed, and every browser
// run needs it: a missing artifact FAILS the first test here, and the rest
// skip, saying so.

import { constantRatioMeasureText, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import {
  installOkfCore,
  installSpatialCore,
  okfCoreInstalled,
  parseOkf,
  parseSpatial,
  serializeOkf,
  serializeSpatial,
  spatialCoreInstalled,
} from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { codecsReady } from '../codec-cores.js'
import type { LayoutRequest, LayoutResponse } from '../layout-worker-protocol.js'
import { startLayoutCore } from '../page-layout-core.js'
import { createEditorAppearance } from './editor-appearance.js'
import { createLayoutCoreHost, layoutCoreReady } from './layout-core.js'
import { requireLayoutCore } from './require-layout-core.js'

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
  it('finds the staged artifact where the pipeline promised it', () => {
    if ('failure' in real) throw real.failure
  })

  it.skipIf('failure' in real)('lays boards out as the TypeScript composer does', async () => {
    if ('failure' in real) return
    const { routing } = real
    let calls = 0
    const host = createLayoutCoreHost(async () => routing)
    const core = await host.ready()
    const counted = {
      ...core,
      layout: {
        layoutSpatialCanvas: (...args: Parameters<typeof routing.layoutSpatialCanvas>) => {
          calls += 1
          return routing.layoutSpatialCanvas(...args)
        },
      },
    }
    for (const style of ['orthogonal', 'curved', 'straight'] as const) {
      const options = {
        measure: constantRatioMeasureText,
        appearance: createEditorAppearance('light'),
      }
      const scene = layoutSpatialCanvas(board(style), { ...options, core: counted })
      expect(scene.nodes.length).toBeGreaterThan(0)
      expect(scene, style).toEqual(
        layoutSpatialCanvas(board(style), { ...options, core: requireLayoutCore() }),
      )
    }
    // The core was asked for every board, so the comparison compared its answers.
    expect(calls).toBe(3)
  })
})

describe('the real Rust core reading and writing OKF in a browser', () => {
  const text = '---\ntype: note\ntitle: Plan\ntags: [a, b]\nweight: -0.0\n---\n# 計画\n\nbody\n'

  it.skipIf('failure' in real)(
    'reads and writes a note through the plain exports once the page awaits the core',
    async () => {
      // The realm's own installation is put back, since it is process-global.
      const previous = installOkfCore(undefined)
      try {
        expect(okfCoreInstalled()).toBe(false)
        await codecsReady()
        expect(okfCoreInstalled()).toBe(true)
        const parsed = parseOkf(text)
        if (!parsed.ok) throw new Error(parsed.error.message)
        expect(serializeOkf(parsed.value)).toContain('# 計画')
        expect(parseOkf('---\ntype: [\n---\n').ok).toBe(false)
      } finally {
        installOkfCore(previous)
      }
    },
  )

  it('fails loudly, not silently, when no core is installed', () => {
    const previous = installOkfCore(undefined)
    try {
      expect(() => parseOkf(text)).toThrow(/installOkfCore/)
    } finally {
      installOkfCore(previous)
    }
  })
})

describe('the real Rust core reading and writing JSON Canvas in a browser', () => {
  it.skipIf('failure' in real)(
    'reads and writes a board through the plain exports once the page awaits the core',
    async () => {
      // The realm's own installation is put back, since it is process-global.
      const previous = installSpatialCore(undefined)
      try {
        expect(spatialCoreInstalled()).toBe(false)
        await codecsReady()
        expect(spatialCoreInstalled()).toBe(true)
        const text = serializeSpatial(board('orthogonal'), 'extended')
        const parsed = parseSpatial(text)
        if (!parsed.ok) throw new Error(parsed.error.message)
        expect(serializeSpatial(parsed.value, 'strict')).toContain('"nodes"')
        expect(parseSpatial('{').ok).toBe(false)
      } finally {
        installSpatialCore(previous)
      }
    },
  )

  it('fails loudly, not silently, when no core is installed', () => {
    const previous = installSpatialCore(undefined)
    try {
      expect(() => parseSpatial('{"nodes":[],"edges":[]}')).toThrow(/installSpatialCore/)
      expect(() => serializeSpatial(board('straight'), 'extended')).toThrow(/installSpatialCore/)
    } finally {
      installSpatialCore(previous)
    }
  })
})

describe('the page core', () => {
  it('loads although the page has since replaced fetch, which knows nothing of the wasm', async () => {
    void startLayoutCore()
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    try {
      expect(await layoutCoreReady()).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the layout worker', () => {
  it('lays a board out through its own loaded core', async () => {
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
    // A core that failed to load fails the request: there is no TypeScript to
    // answer in its place, so `laid-out` is the core having answered.
    expect(reply.type).toBe('laid-out')
  }, 60_000)
})
