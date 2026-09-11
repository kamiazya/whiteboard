/**
 * Property-based coverage for the scene parse/serialize boundary. Built from
 * model's own shared node/edge arbitraries (not duplicated here) —
 * see model/src/test-utils/arbitraries.ts. There is no published
 * "whole SpatialCanvas" arbitrary yet upstream, so this file composes one
 * locally (unique node ids, edges referencing only generated node ids).
 */

import { fromJsonCanvas, strictDegrade, toJsonCanvas } from '@kamiazya/whiteboard-codec'
import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { parseViewerScene, serializeViewerScene } from './scene.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

describe('scene parse/serialize properties', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'extended mode round-trip: parse(serialize(x, "extended")) equals x, once x is expressible',
    (canvas) => {
      // Extended mode is lossless over what the FORMAT can state, which since
      // ADR-0035 slice 4 excludes sub-pixel geometry: JSON Canvas 1.0 is
      // integer pixels and the projection rounds. Putting the canvas through
      // the projection first is what names that subset.
      const expressible = fromJsonCanvas(toJsonCanvas(canvas))
      const json = serializeViewerScene(expressible, 'extended')
      const result = parseViewerScene(json)
      expect(result).toEqual({ ok: true, value: expressible })
    },
  )

  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'strict mode round-trip: parse(serialize(x, "strict")) equals the degraded PROJECTION of x',
    (canvas) => {
      // Degradation is a wire-level rule, so the expectation is the canvas
      // projected onto JSON Canvas, degraded there, and lifted back — not the
      // model degraded in place. Since ADR-0035 those are different documents:
      // the projection is where `facets`, `comments` and `embed` become the
      // extension key that strict mode then drops.
      const json = serializeViewerScene(canvas, 'strict')
      const result = parseViewerScene(json)
      expect(result).toEqual({
        ok: true,
        value: fromJsonCanvas(strictDegrade(toJsonCanvas(canvas))),
      })
    },
  )

  it('parseViewerScene never throws for arbitrary JSON-like input', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (input) => {
        expect(() => parseViewerScene(input)).not.toThrow()
      }),
      { numRuns: 200 },
    )
  })
})
