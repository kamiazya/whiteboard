import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { CanvasLayoutCore, CanvasLayoutRequest } from '../../canvas-core.js'
import type { CoreImpl, CoreMismatch, LayoutCore } from '../../layout/edges/layout-core.js'
import type { SpatialLayoutOptions } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { built, requireWasm, wasmBytes } from './glue.js'
import { layoutCases } from './layout-cases.js'

/**
 * The whole layout through the REAL core (ADR-0054 step 7): canvas-render's
 * `layoutSpatialCanvasWithAnchors` under `differential`, which runs the
 * TypeScript and the core's `layout_spatial_canvas` over one request and
 * reports any difference in the scene, the anchors or the degradations, and
 * under `rust`, which answers with the core. The layouts are `layout-cases.ts`.
 */
describe.runIf(built)('the whole layout through the real core', () => {
  const real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  const answered = { compared: 0, declined: [] as string[] }
  const counting: CanvasLayoutCore = {
    layoutSpatialCanvas(request: CanvasLayoutRequest) {
      const answer = real.layoutSpatialCanvas(request)
      if ('declined' in answer) answered.declined.push(answer.declined)
      else answered.compared += 1
      return answer
    },
  }
  const lay = (canvas: SpatialCanvas, options: SpatialLayoutOptions, impl: CoreImpl) => {
    const mismatches: CoreMismatch[] = []
    const core: LayoutCore = {
      routing: real,
      layout: counting,
      impl: { routeLayout: 'ts', layoutSpatialCanvas: impl },
      onMismatch: (mismatch) => mismatches.push(mismatch),
    }
    return { ...layoutSpatialCanvasWithAnchors(canvas, { ...options, core }), mismatches }
  }

  const cases = layoutCases(20)
  it('reports no difference under differential, and rust draws what the TypeScript draws', () => {
    for (const { name, canvas, options } of cases) {
      const reference = layoutSpatialCanvasWithAnchors(canvas, options)
      const differential = lay(canvas, options, 'differential')
      expect(differential.mismatches, name).toEqual([])
      expect(differential.scene, name).toEqual(reference.scene)
      const rust = lay(canvas, options, 'rust')
      expect(rust.mismatches, name).toEqual([])
      expect(rust.scene, name).toEqual(reference.scene)
      expect(Object.fromEntries(rust.anchors), name).toEqual(Object.fromEntries(reference.anchors))
    }
    // Every layout but the two built to be declined is compared: the core is judged, not skipped.
    expect(answered.compared).toBe(2 * (cases.length - 2))
    expect(answered.declined).toEqual(['highlight', 'highlight', 'shortcode', 'shortcode'])
  })
})
