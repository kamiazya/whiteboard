// @vitest-environment node
// What a gesture's layers are handed: the same canvas envelope the committed
// scene draws from, with only the COMMENTS partitioned between the layer
// that carries a node and the layer that stays. A theme is an envelope
// facet (ADR-0030), so dropping the envelope on one layer is a board that
// changes look for the length of a drag.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect } from 'vitest'
import { facetsArbitrary } from '../../test-utils/facet-arbitrary.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { commentExtensionFor } from './gesture-view.js'

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
const canvasArb: fc.Arbitrary<SpatialCanvas> = envelopeArb.map((envelope) => ({
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
  ...(envelope === undefined ? {} : { 'x-whiteboard': envelope }),
}))
const carriedArb = fc.uniqueArray(idArb).map((ids) => new Set<string>(ids))

const withoutComments = (extension: SpatialCanvas['x-whiteboard']) => {
  if (extension === undefined) return undefined
  const { comments: _comments, ...rest } = extension
  return Object.keys(rest).length === 0 ? undefined : rest
}

describe('commentExtensionFor (fast-check)', () => {
  fcTest.prop([canvasArb, carriedArb], PROPERTY_PARAMS)(
    'both layers keep everything in the envelope except the comments, so a theme survives a gesture',
    (canvas, carried) => {
      const source = withoutComments(canvas['x-whiteboard'])
      expect(withoutComments(commentExtensionFor(canvas, carried, true))).toEqual(source)
      expect(withoutComments(commentExtensionFor(canvas, carried, false))).toEqual(source)
    },
  )

  fcTest.prop([canvasArb, carriedArb], PROPERTY_PARAMS)(
    'the comments are partitioned: a carried target rides the ghost, everything else stays',
    (canvas, carried) => {
      const all = canvas['x-whiteboard']?.comments ?? []
      const ghost = commentExtensionFor(canvas, carried, true)?.comments ?? []
      const base = commentExtensionFor(canvas, carried, false)?.comments ?? []
      expect(ghost.every((c) => c.targetNodeId !== undefined && carried.has(c.targetNodeId))).toBe(
        true,
      )
      expect(base.every((c) => c.targetNodeId === undefined || !carried.has(c.targetNodeId))).toBe(
        true,
      )
      expect([...ghost, ...base].map((c) => c.id).sort()).toEqual(all.map((c) => c.id).sort())
    },
  )
})
