import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CanvasLayoutCore, CanvasLayoutRequest } from '../../canvas-core.js'
import type { SpatialLayoutOptions } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { describeMeasure, type MeasureText } from '../../measure.js'
import { type LayoutRefusal, refusalScene } from '../../refusal.js'
import { fakeLayoutCore } from '../fake-layout-core.js'
import { built, requireWasm, wasmBytes } from './glue.js'
import { layoutCases } from './layout-cases.js'

/**
 * The whole layout through the REAL core (ADR-0054 step 7): canvas-render's
 * `layoutSpatialCanvasWithAnchors` handed the core, which answers with its
 * `layout_spatial_canvas`, held to the scene and the anchors the TypeScript
 * composer draws handed none. The layouts are `layout-cases.ts`.
 */
describe.runIf(built)('the whole layout through the real core', () => {
  // Made in `beforeAll`, not in this factory: vitest runs a skipped suite's
  // factory to collect it, so a core made here fails the file where there is
  // no artifact instead of skipping it.
  let real: Core
  beforeAll(() => {
    real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })
  const answered = { compared: 0, refused: [] as string[] }
  const counting: CanvasLayoutCore = {
    layoutSpatialCanvas(request: CanvasLayoutRequest, highlight, measure) {
      const answer = real.layoutSpatialCanvas(request, highlight, measure)
      if ('refused' in answer) answered.refused.push(answer.refused.reason)
      else answered.compared += 1
      return answer
    },
  }
  const lay = (canvas: SpatialCanvas, options: SpatialLayoutOptions) =>
    layoutSpatialCanvasWithAnchors(canvas, {
      ...options,
      core: fakeLayoutCore({ routing: real, layout: counting }),
    })

  const cases = layoutCases(20)
  it('draws what the TypeScript draws', () => {
    for (const { name, canvas, options } of cases) {
      const reference = layoutSpatialCanvasWithAnchors(canvas, options)
      const rust = lay(canvas, options)
      expect(rust.scene, name).toEqual(reference.scene)
      expect(Object.fromEntries(rust.anchors), name).toEqual(Object.fromEntries(reference.anchors))
    }
    // Every layout is compared: the core is judged, never refused.
    expect(answered.compared).toBe(cases.length)
    expect(answered.refused).toEqual([])
  })

  it('draws what the TypeScript draws when the core asks the measurer itself', () => {
    answered.compared = 0
    let asked = 0
    for (const { name, canvas, options } of cases) {
      const own = options.measure
      const host: MeasureText = describeMeasure(
        (text, font) => {
          asked += 1
          return own(text, font)
        },
        { kind: 'host' },
      )
      const hosted = { ...options, measure: host }
      let tsAsked = 0
      const reference = layoutSpatialCanvasWithAnchors(canvas, {
        ...options,
        measure: (text, font) => {
          tsAsked += 1
          return own(text, font)
        },
      })
      const before = asked
      const rust = lay(canvas, hosted)
      // Only the core measures, so a layout the TypeScript measured in must
      // have asked the host through the import.
      if (tsAsked > 0) expect(asked, name).toBeGreaterThan(before)
      expect(rust.scene, name).toEqual(reference.scene)
      expect(Object.fromEntries(rust.anchors), name).toEqual(Object.fromEntries(reference.anchors))
    }
    expect(answered.compared).toBe(cases.length)
    expect(answered.refused).toEqual([])
    expect(asked).toBeGreaterThan(cases.length)
  })

  it('draws the refusal for a layout whose host answers a number that is not finite', () => {
    answered.refused.length = 0
    const [first] = cases
    if (first === undefined) throw new Error('no layout cases')
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const own = first.options.measure
      const host: MeasureText = describeMeasure(
        (text, font) => ({ ...own(text, font), ascent: bad }),
        { kind: 'host' },
      )
      const heard: LayoutRefusal[] = []
      const hosted = {
        ...first.options,
        measure: host,
        onRefused: (r: LayoutRefusal) => heard.push(r),
      }
      const rust = lay(first.canvas, hosted)
      const refused = { code: 'malformed', reason: 'host-measure' } as const
      expect(heard).toEqual([refused])
      const drawn = (['light', 'dark'] as const).map((mode) =>
        refusalScene(refused, { measure: host, mode }),
      )
      expect(drawn).toContainEqual(rust.scene)
    }
    // The core answered each with its refusal, which the surface drew.
    expect(answered.refused).toEqual(['host-measure', 'host-measure'])
  })
})
