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

  it('names no surface twice across two cores over one instance', () => {
    // wasm-bindgen's initSync answers the instance it already holds, so two
    // cores built over one glue share the core's store.
    const sent: unknown[][] = []
    const glue = glueSending(sent)
    const first = coreFrom(glue, new Uint8Array())
    const second = coreFrom(glue, new Uint8Array())
    const request = { measure: { kind: 'ratio' } } as const
    first.layoutSpatialCanvas(request, undefined, undefined, {})
    second.layoutSpatialCanvas(request, undefined, undefined, {})
    expect(sent.map(surface)).toEqual([0, 1])
  })

  it('sends a layout handed a cache its surface, and one handed none no surface', () => {
    const sent: unknown[][] = []
    const glue = glueSending(sent)
    const core = coreFrom(glue, new Uint8Array())
    const request = { measure: { kind: 'ratio' } } as const
    const [a, b] = [{}, {}]
    core.layoutSpatialCanvas(request, undefined, undefined, a)
    core.layoutSpatialCanvas(request, undefined, undefined, b)
    core.layoutSpatialCanvas(request, undefined, undefined, a)
    core.layoutSpatialCanvas(request)
    expect(sent.map(surface)).toEqual([0, 1, 0, undefined])
  })
})

/** The surface a sent request names, if any. */
const surface = (wire: unknown[]) =>
  wire.includes('cache') ? wire[wire.indexOf('cache') + 1] : undefined

/** A glue whose layouts decline, keeping every request sent. */
function glueSending(sent: unknown[][]): CoreGlue {
  return {
    initSync: () => undefined,
    abi_version: () => EXPECTED_ABI,
    __wbg_reset_state: () => undefined,
    edge_route_layout: () => new Float64Array(),
    okf_parse: () => '',
    okf_serialize: () => '',
    json_canvas_parse: () => '',
    json_canvas_serialize: () => '',
    facet_bucket_check: () => '',
    layout_spatial_canvas: (request) => {
      sent.push(JSON.parse(request) as unknown[])
      return '["refused","input-too-large","x"]'
    },
    register_layout_fonts: () => '[]',
    release_layout_fonts: () => false,
    release_layout_cache: () => false,
    search_op: () => '[]',
    layout_query: () => '',
  }
}
