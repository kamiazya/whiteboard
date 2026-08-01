/**
 * Property-based coverage for the scene parse/serialize boundary. Built from
 * canvas-model's own shared node/edge arbitraries (not duplicated here) —
 * see canvas-model/src/test-utils/arbitraries.ts. There is no published
 * "whole SpatialCanvas" arbitrary yet upstream, so this file composes one
 * locally (unique node ids, edges referencing only generated node ids).
 */

import { strictDegrade } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import {
  canvasEdgeArbitrary,
  spatialNodeArbitrary,
} from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect, it } from 'vitest'
import { parseViewerScene, serializeViewerScene } from './scene.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

// Unique-by-id nodes, then edges restricted to reference only those ids —
// this is what keeps every generated canvas schema-valid (the duplicate-id
// and dangling-reference invariants live in spatialCanvasSchema itself).
const spatialCanvasArbitrary: fc.Arbitrary<SpatialCanvas> = fc
  .uniqueArray(spatialNodeArbitrary, { minLength: 0, maxLength: 5, selector: (n) => n.id })
  .chain((nodes) => {
    if (nodes.length === 0) return fc.constant({ nodes, edges: [] })
    const nodeIdArb = fc.constantFrom(...nodes.map((n) => n.id))
    return fc
      .array(
        canvasEdgeArbitrary.chain((edge) =>
          fc.tuple(nodeIdArb, nodeIdArb).map(([fromNode, toNode]) => ({
            ...edge,
            fromNode,
            toNode,
          })),
        ),
        { maxLength: 3 },
      )
      .chain((edges) => {
        // Dedup edge ids the same way node ids are deduped, so the
        // superRefine duplicate-id check never rejects a generated sample.
        const seen = new Set<string>()
        const uniqueEdges = edges.filter((e) => {
          if (seen.has(e.id)) return false
          seen.add(e.id)
          return true
        })
        return fc.constant({ nodes, edges: uniqueEdges })
      })
  })

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
