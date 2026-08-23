// The parity this package's one-producer rule requires. `buildAnchorGroups`
// derives the anchor partition from scratch; `patchAnchorGroups` derives the
// same partition for a one-edge re-side by reusing the incumbent's. Every
// trial the side-choice search evaluates takes the second path, so the two
// have to agree exactly — not approximately, and not only on the shapes
// somebody thought to write an example for.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import {
  type AnchorGroups,
  anchorContext,
  buildAnchorGroups,
  patchAnchorGroups,
} from './spatial-edges.js'

const SIDES = ['top', 'right', 'bottom', 'left'] as const
type Side = (typeof SIDES)[number]

const layout = fc
  .record({
    nodeCount: fc.integer({ min: 2, max: 6 }),
    boxes: fc.array(
      fc.record({
        x: fc.integer({ min: -400, max: 400 }),
        y: fc.integer({ min: -400, max: 400 }),
        w: fc.integer({ min: 20, max: 200 }),
        h: fc.integer({ min: 20, max: 200 }),
      }),
      { minLength: 6, maxLength: 6 },
    ),
    // Deliberately dense: with few nodes and many edges, sides collide, so
    // groups hold several ends and a re-side actually changes fan-out
    // fractions instead of moving a lone end between empty sides.
    links: fc.array(
      fc.record({
        from: fc.integer({ min: 0, max: 5 }),
        to: fc.integer({ min: 0, max: 5 }),
        fromSide: fc.constantFrom(...SIDES),
        toSide: fc.constantFrom(...SIDES),
      }),
      { minLength: 1, maxLength: 12 },
    ),
    reSide: fc.record({
      index: fc.nat(),
      fromSide: fc.constantFrom(...SIDES),
      toSide: fc.constantFrom(...SIDES),
    }),
  })
  .map(({ nodeCount, boxes, links, reSide }) => {
    const nodes: SpatialNode[] = boxes.slice(0, nodeCount).map((b, i) => ({
      id: `n${i}`,
      type: 'text',
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      text: `n${i}`,
    }))
    const edges: CanvasEdge[] = links.map((l, i) => ({
      id: `e${i}`,
      fromNode: `n${l.from % nodeCount}`,
      toNode: `n${l.to % nodeCount}`,
    }))
    const sides = new Map<string, { fromSide: Side; toSide: Side }>(
      links.map((l, i) => [`e${i}`, { fromSide: l.fromSide, toSide: l.toSide }]),
    )
    return { nodes, edges, sides, target: reSide.index % edges.length, next: reSide }
  })

/** Group membership as a comparable value: the alignment pass reads sizes,
 *  and placement reads the members themselves. */
const shapeOf = (g: AnchorGroups) => ({
  entries: [...g.entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  sizes: [...g.groups.entries()]
    .map(([k, v]) => [k, v.length] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
})

describe('patchAnchorGroups agrees with a full rebuild', () => {
  fcTest.prop([layout], withDefaults())(
    'a one-edge re-side lands the same partition either way',
    ({ nodes, edges, sides, target, next }) => {
      const ctx = anchorContext(nodes, edges)
      const base = buildAnchorGroups(ctx, sides)
      const edge = edges[target]
      if (edge === undefined) return
      const trial = new Map(sides)
      trial.set(edge.id, { fromSide: next.fromSide, toSide: next.toSide })

      const patched = patchAnchorGroups(ctx, base, trial, target)
      const rebuilt = buildAnchorGroups(ctx, trial)
      expect(shapeOf(patched)).toEqual(shapeOf(rebuilt))
    },
  )

  fcTest.prop([layout], withDefaults())(
    're-siding to the sides it already has is the identity',
    ({ nodes, edges, sides, target }) => {
      const ctx = anchorContext(nodes, edges)
      const base = buildAnchorGroups(ctx, sides)
      const edge = edges[target]
      if (edge === undefined) return
      const patched = patchAnchorGroups(ctx, base, sides, target)
      expect(shapeOf(patched)).toEqual(shapeOf(base))
    },
  )
})
