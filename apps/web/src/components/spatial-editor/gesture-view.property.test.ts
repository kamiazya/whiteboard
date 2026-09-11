// @vitest-environment node
// What a gesture's layers are handed: the same facets the committed scene
// draws from, with only the COMMENTS partitioned between the layer that
// carries a node and the layer that stays. A theme is a canvas facet
// (ADR-0030), so a layer built without them is a board that changes look for
// the length of a drag — a defect this editor shipped once.
//
// The facets used to ride inside the canvas envelope, which is why one helper
// once carried both halves. Since ADR-0033 they are a field of the canvas and
// `layerCanvas` is the single place a layer is built, so the property is over
// that rather than over an envelope split.

import { facetsArbitrary } from '@kamiazya/whiteboard-facet-engine/testing'
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { commentsFor, layerCanvas } from './gesture-view.js'

const PROPERTY_PARAMS = withDefaults({ numRuns: 100 })

const idArb = fc.constantFrom('a', 'b', 'c', 'd')
const commentArb = fc.record(
  {
    id: fc.uuid(),
    x: fc.integer({ min: -100, max: 100 }),
    y: fc.integer({ min: -100, max: 100 }),
    text: fc.constant('a note'),
    targetNodeId: idArb,
  },
  { requiredKeys: ['id', 'x', 'y', 'text'] },
)
// Drawn from the registry, so the property follows every canvas facet a
// plugin registers — the theme today, whatever comes next without an edit.
const facetsArb = facetsArbitrary(bundledFacetRegistry, 'canvas')
const envelopeArb = fc.option(
  fc.record(
    { facets: facetsArb, comments: fc.array(commentArb, { maxLength: 6 }) },
    { requiredKeys: [] },
  ),
  { nil: undefined },
)
const canvasArb: fc.Arbitrary<SpatialCanvas> = envelopeArb.map(
  (envelope): SpatialCanvas => ({
    nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({
      id,
      type: 'text' as const,
      x: i * 100,
      y: 0,
      width: 80,
      height: 40,
      text: id,
    })),
    edges: [],
    ...(envelope?.facets === undefined ? {} : { facets: envelope.facets }),
    ...(envelope?.comments === undefined ? {} : { comments: envelope.comments }),
  }),
)
const carriedArb = fc.uniqueArray(idArb).map((ids) => new Set<string>(ids))

describe('a gesture layer (fast-check)', () => {
  fcTest.prop([canvasArb, carriedArb], PROPERTY_PARAMS)(
    'every layer carries the canvas facets, so a theme survives a gesture',
    (canvas, carried) => {
      const ghost = layerCanvas(canvas, canvas.nodes, commentsFor(canvas, carried, true))
      const base = layerCanvas(canvas, canvas.nodes, commentsFor(canvas, carried, false))
      expect(ghost.facets).toEqual(canvas.facets)
      expect(base.facets).toEqual(canvas.facets)
    },
  )

  fcTest.prop([canvasArb, carriedArb], PROPERTY_PARAMS)(
    'the comments are partitioned: a carried target rides the ghost, everything else stays',
    (canvas, carried) => {
      const all = canvas.comments ?? []
      const ghost = commentsFor(canvas, carried, true) ?? []
      const base = commentsFor(canvas, carried, false) ?? []
      expect(
        ghost.every(
          (c: CanvasComment) => c.targetNodeId !== undefined && carried.has(c.targetNodeId),
        ),
      ).toBe(true)
      expect(
        base.every(
          (c: CanvasComment) => c.targetNodeId === undefined || !carried.has(c.targetNodeId),
        ),
      ).toBe(true)
      expect([...ghost, ...base].map((c: CanvasComment) => c.id).sort()).toEqual(
        all.map((c: CanvasComment) => c.id).sort(),
      )
    },
  )
})
