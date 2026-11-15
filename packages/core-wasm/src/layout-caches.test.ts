import { describe, expect, it } from 'vitest'
import type { Finalizer } from './font-handles.js'
import { type CoreGlue, coreFrom, EXPECTED_ABI } from './index.js'
import { LayoutCaches } from './layout-caches.js'

/** A finalizer that collects only when told to, as `FinalizationRegistry` would. */
function finalizerOf() {
  const watched: { token: object; surface: number }[] = []
  let release: (surface: number) => void = () => undefined
  const make = (onCollect: (surface: number) => void): Finalizer => {
    release = onCollect
    return {
      register: (_target, surface, token) => void watched.push({ token, surface }),
      unregister: () => undefined,
    }
  }
  const collect = (token: object) => {
    for (const entry of watched) if (entry.token === token) release(entry.surface)
  }
  return { make, collect }
}

describe('a content cache kept in the core', () => {
  it('names one cache by one surface, another by another, and releases it once collected', () => {
    const released: number[] = []
    const finalizer = finalizerOf()
    const caches = new LayoutCaches(
      { release_layout_cache: (surface) => released.push(surface) > 0 },
      finalizer.make,
    )
    const a = {}
    const b = {}
    expect([caches.surfaceOf(a), caches.surfaceOf(b), caches.surfaceOf(a)]).toEqual([0, 1, 0])
    expect(released).toEqual([])
    finalizer.collect(b)
    expect(released).toEqual([1])
    // A surface is never named again, so one released cannot answer another cache.
    expect(caches.surfaceOf({})).toBe(2)
  })

  it('sends a layout handed a cache its surface, and one handed none no surface', () => {
    const sent: unknown[][] = []
    const glue: CoreGlue = {
      initSync: () => undefined,
      abi_version: () => EXPECTED_ABI,
      edge_route_layout: () => new Float64Array(),
      okf_parse: () => '',
      okf_serialize: () => '',
      json_canvas_parse: () => '',
      json_canvas_serialize: () => '',
      facet_bucket_check: () => '',
      layout_spatial_canvas: (request) => {
        sent.push(JSON.parse(request) as unknown[])
        return '["declined","x"]'
      },
      register_layout_fonts: () => '[]',
      release_layout_fonts: () => false,
      release_layout_cache: () => false,
    }
    const core = coreFrom(glue, new Uint8Array())
    const request = { measure: { kind: 'ratio' } } as const
    const [a, b] = [{}, {}]
    core.layoutSpatialCanvas(request, undefined, undefined, a)
    core.layoutSpatialCanvas(request, undefined, undefined, b)
    core.layoutSpatialCanvas(request, undefined, undefined, a)
    core.layoutSpatialCanvas(request)
    const surface = (wire: unknown[]) =>
      wire.includes('cache') ? wire[wire.indexOf('cache') + 1] : undefined
    expect(sent.map(surface)).toEqual([0, 1, 0, undefined])
  })
})
