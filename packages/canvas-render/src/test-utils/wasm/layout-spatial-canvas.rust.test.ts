import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CanvasLayoutCore, CanvasLayoutRequest } from '../../canvas-core.js'
import type { CoreImpl, CoreMismatch, LayoutCore } from '../../layout/edges/layout-core.js'
import type { SpatialLayoutOptions } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { describeMeasure, type MeasureText } from '../../measure.js'
import { type LayoutRefusal, refusalScene } from '../../refusal.js'
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
  // Made in `beforeAll`, not in this factory: vitest runs a skipped suite's
  // factory to collect it, so a core made here fails the file where there is
  // no artifact instead of skipping it.
  let real: Core
  beforeAll(() => {
    real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })
  const answered = { compared: 0, declined: [] as string[] }
  const counting: CanvasLayoutCore = {
    layoutSpatialCanvas(request: CanvasLayoutRequest, highlight, measure) {
      const answer = real.layoutSpatialCanvas(request, highlight, measure)
      if ('declined' in answer) answered.declined.push(answer.declined)
      else answered.compared += 1
      return answer
    },
  }
  const lay = (canvas: SpatialCanvas, options: SpatialLayoutOptions, impl: CoreImpl) => {
    const mismatches: CoreMismatch[] = []
    const tallies: string[] = []
    const core: LayoutCore = {
      routing: real,
      layout: counting,
      impl: { routeLayout: 'ts', layoutSpatialCanvas: impl },
      onMismatch: (mismatch) => {
        if (mismatch.kind === 'skipped' || mismatch.kind === 'declined') {
          tallies.push(`${mismatch.kind}:${mismatch.reason}`)
        } else mismatches.push(mismatch)
      },
    }
    const laid = layoutSpatialCanvasWithAnchors(canvas, { ...options, core })
    return { ...laid, mismatches, tallies }
  }

  const cases = layoutCases(20)
  it('reports no difference under differential, and rust draws what the TypeScript draws', () => {
    const tallies: string[] = []
    for (const { name, canvas, options } of cases) {
      const reference = layoutSpatialCanvasWithAnchors(canvas, options)
      const differential = lay(canvas, options, 'differential')
      expect(differential.mismatches, name).toEqual([])
      expect(differential.scene, name).toEqual(reference.scene)
      const rust = lay(canvas, options, 'rust')
      expect(rust.mismatches, name).toEqual([])
      tallies.push(...differential.tallies, ...rust.tallies)
      expect(rust.scene, name).toEqual(reference.scene)
      expect(Object.fromEntries(rust.anchors), name).toEqual(Object.fromEntries(reference.anchors))
    }
    // Every layout is compared: the core is judged, never declined or skipped.
    expect(answered.compared).toBe(2 * cases.length)
    expect(answered.declined).toEqual([])
    expect(tallies).toEqual([])
  })

  it('draws what the TypeScript draws when the core asks the measurer itself', () => {
    answered.compared = 0
    const tallies: string[] = []
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
      const differential = lay(canvas, hosted, 'differential')
      expect(differential.mismatches, name).toEqual([])
      const before = asked
      const rust = lay(canvas, hosted, 'rust')
      expect(rust.mismatches, name).toEqual([])
      // Under `rust` only the core measures, so a layout the TypeScript
      // measured in must have asked the host through the import.
      if (tsAsked > 0) expect(asked, name).toBeGreaterThan(before)
      tallies.push(...differential.tallies, ...rust.tallies)
      expect(rust.scene, name).toEqual(reference.scene)
      expect(Object.fromEntries(rust.anchors), name).toEqual(Object.fromEntries(reference.anchors))
    }
    expect(answered.compared).toBe(2 * cases.length)
    expect(answered.declined).toEqual([])
    expect(tallies).toEqual([])
    expect(asked).toBeGreaterThan(cases.length)
  })

  it('draws the refusal for a layout whose host answers a number that is not finite', () => {
    answered.declined.length = 0
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
      const rust = lay(first.canvas, hosted, 'rust')
      expect(rust.tallies).toEqual(['declined:host-measure'])
      expect(rust.mismatches).toEqual([])
      const refused = { code: 'malformed', reason: 'host-measure' } as const
      expect(heard).toEqual([refused])
      const drawn = (['light', 'dark'] as const).map((mode) =>
        refusalScene(refused, { measure: host, mode }),
      )
      expect(drawn).toContainEqual(rust.scene)
    }
    // A refusal is not a decline: the core answered it.
    expect(answered.declined).toEqual([])
  })
})
