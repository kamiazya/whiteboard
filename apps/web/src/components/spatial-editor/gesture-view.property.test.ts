// @vitest-environment node
// What a gesture's layers are handed: the same facets the committed scene
// draws from, with only the comment THREADS partitioned between the layer
// that carries a node and the layer that stays. A theme is a canvas facet
// (ADR-0030), so a layer built without them is a board that changes look for
// the length of a drag — a defect this editor shipped once.
//
// The facets used to ride inside the canvas envelope, which is why one helper
// once carried both halves. Since ADR-0037 they are a field of the canvas and
// `layerCanvas` is the single place a layer is built, so the property is over
// that rather than over an envelope split.

import { facetsArbitrary } from '@kamiazya/whiteboard-facet-engine/testing'
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { layerCanvas, threadsFor } from './gesture-view.js'

const PROPERTY_PARAMS = withDefaults({ numRuns: 100 })

const idArb = fc.constantFrom('a', 'b', 'c', 'd')
// A thread rides a node through its anchor's `nodeId` — on the node itself or
// on a passage of its text — and any other anchor names no node to ride.
const threadArb: fc.Arbitrary<CommentThread> = fc
  .record({
    id: fc.uuid(),
    x: fc.integer({ min: -100, max: 100 }),
    y: fc.integer({ min: -100, max: 100 }),
    nodeId: fc.option(idArb, { nil: undefined }),
    passage: fc.boolean(),
  })
  .map(({ id, x, y, nodeId, passage }) => ({
    id,
    anchor:
      nodeId !== undefined && passage
        ? { kind: 'text', nodeId, quote: { exact: 'n' }, start: 0, end: 1 }
        : { kind: 'spatial', x, y, ...(nodeId === undefined ? {} : { nodeId }) },
    status: 'open',
    messages: [{ id: `${id}-m1`, body: 'a note' }],
  }))
// Drawn from the registry, so the property follows every canvas facet a
// plugin registers — the theme today, whatever comes next without an edit.
const facetsArb = facetsArbitrary(bundledFacetRegistry, 'canvas')
const canvasArb: fc.Arbitrary<SpatialCanvas> = fc.option(facetsArb, { nil: undefined }).map(
  (facets): SpatialCanvas => ({
    nodes: ['a', 'b', 'c', 'd'].map((id, i) =>
      textNode({ id, x: i * 100, y: 0, width: 80, height: 40, text: id }),
    ),
    edges: [],
    ...(facets === undefined ? {} : { facets }),
  }),
)
const threadsArb = fc.array(threadArb, { maxLength: 6 })
const carriedArb = fc.uniqueArray(idArb).map((ids) => new Set<string>(ids))
const riddenNode = (thread: CommentThread) =>
  thread.anchor.kind === 'document' ? undefined : thread.anchor.nodeId

describe('a gesture layer (fast-check)', () => {
  fcTest.prop([canvasArb, carriedArb], PROPERTY_PARAMS)(
    'every layer carries the canvas facets, so a theme survives a gesture',
    (canvas, carried) => {
      const ghost = layerCanvas(
        canvas,
        canvas.nodes.filter((n) => carried.has(n.id)),
      )
      const base = layerCanvas(
        canvas,
        canvas.nodes.filter((n) => !carried.has(n.id)),
      )
      expect(ghost.facets).toEqual(canvas.facets)
      expect(base.facets).toEqual(canvas.facets)
    },
  )

  fcTest.prop([threadsArb, carriedArb], PROPERTY_PARAMS)(
    'the threads are partitioned: one about a carried node rides the ghost, everything else stays',
    (threads, carried) => {
      const ghost = threadsFor(threads, carried, true)
      const base = threadsFor(threads, carried, false)
      expect(
        ghost.every((t) => {
          const node = riddenNode(t)
          return node !== undefined && carried.has(node)
        }),
      ).toBe(true)
      expect(
        base.every((t) => {
          const node = riddenNode(t)
          return node === undefined || !carried.has(node)
        }),
      ).toBe(true)
      expect([...ghost, ...base].map((t) => t.id).sort()).toEqual(threads.map((t) => t.id).sort())
    },
  )
})
