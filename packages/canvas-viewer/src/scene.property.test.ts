/**
 * Property-based coverage for the scene parse/serialize boundary. Built from
 * canvas-model's own shared node/edge arbitraries (not duplicated here) —
 * see canvas-model/src/test-utils/arbitraries.ts. There is no published
 * "whole SpatialCanvas" arbitrary yet upstream, so this file composes one
 * locally (unique node ids, edges referencing only generated node ids).
 */

import { strictDegrade } from '@kamiazya/whiteboard-canvas-codec'
import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect, it } from 'vitest'
import { parseViewerScene, serializeViewerScene } from './scene.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

describe('scene parse/serialize properties', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'extended mode round-trip: parse(serialize(x, "extended")) equals x',
    (canvas) => {
      const json = serializeViewerScene(canvas, 'extended')
      const result = parseViewerScene(json)
      expect(result).toEqual({ ok: true, value: canvas })
    },
  )

  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'strict mode round-trip: parse(serialize(x, "strict")) equals strictDegrade(x)',
    (canvas) => {
      const json = serializeViewerScene(canvas, 'strict')
      const result = parseViewerScene(json)
      expect(result).toEqual({ ok: true, value: strictDegrade(canvas) })
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
