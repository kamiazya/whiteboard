// @vitest-environment node
// Metamorphic property for buildFragmentInsertCommand: relative geometry and
// node count survive the remint+offset pipeline regardless of which offset
// mode fires. Mutation-checked by temporarily breaking the offset/remint
// rule in commands.ts and confirming this goes red (recorded in the commit).

import type { CanvasLine, ClipboardFragment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { canvasLineArbitrary, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { applyCommand, buildFragmentInsertCommand } from './commands.js'

const rawNodeArb = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  width: fc.integer({ min: 10, max: 200 }),
  height: fc.integer({ min: 10, max: 200 }),
})

const fragmentArb: fc.Arbitrary<Pick<ClipboardFragment, 'nodes' | 'edges'>> = fc
  .array(rawNodeArb, { minLength: 1, maxLength: 5 })
  .map((raws) => ({
    nodes: raws.map((raw, i) => ({ id: `n${i}`, type: 'text' as const, text: '', ...raw })),
    edges: [] as ClipboardFragment['edges'],
  }))

const anchorArb = fc.option(
  fc.record({ x: fc.integer({ min: -500, max: 500 }), y: fc.integer({ min: -500, max: 500 }) }),
  { nil: undefined },
)

describe('buildFragmentInsertCommand properties', () => {
  fcTest.prop([fragmentArb, anchorArb], withDefaults({ numRuns: 100 }))(
    'preserves node count, relative positions, and id disjointness from the source canvas',
    (fragment, anchor) => {
      const canvas: SpatialCanvas = {
        nodes: [textNode({ id: 'existing', x: 0, y: 0, width: 10, height: 10, text: '' })],
        edges: [],
      }
      let counter = 0
      const createId = () => `remint-${counter++}`
      const command = buildFragmentInsertCommand(canvas, fragment, createId, anchor)
      if (command === undefined) return
      const next = applyCommand(canvas, command)
      expect(next.nodes).toHaveLength(canvas.nodes.length + fragment.nodes.length)

      const inserted = next.nodes.slice(canvas.nodes.length)
      expect(inserted.map((n) => n.id)).not.toContain('existing')

      // Relative positions between every pair of source nodes are preserved
      // under the single uniform (dx, dy) translation the builder applies.
      for (let i = 0; i < fragment.nodes.length; i++) {
        for (let j = 0; j < fragment.nodes.length; j++) {
          expect(inserted[j].x - inserted[i].x).toBe(fragment.nodes[j].x - fragment.nodes[i].x)
          expect(inserted[j].y - inserted[i].y).toBe(fragment.nodes[j].y - fragment.nodes[i].y)
        }
      }

      if (anchor !== undefined) {
        // Compare 2x(center) to 2x(anchor) instead of rounding twice: the
        // builder itself rounds once (dx = round(anchor - center)), so the
        // final center can land up to 0.5px off the anchor — bounding the
        // doubled difference by 1 captures exactly that tolerance without a
        // second, compounding round() in the assertion.
        const minX = Math.min(...inserted.map((n) => n.x))
        const maxX = Math.max(...inserted.map((n) => n.x + n.width))
        const minY = Math.min(...inserted.map((n) => n.y))
        const maxY = Math.max(...inserted.map((n) => n.y + n.height))
        expect(Math.abs(minX + maxX - 2 * anchor.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(minY + maxY - 2 * anchor.y)).toBeLessThanOrEqual(1)
      }
    },
  )
})

/**
 * Moving a stroke is a TRANSLATION, and the two things that makes true are
 * exactly what an example cannot pin over the shapes a line comes in: an end
 * on a node, an end on a point, with bends and without.
 *
 * Additivity is the statement, not a round trip, because a round trip is its
 * special case and passes under a half-implemented move that forgets the
 * bends (they would be forgotten symmetrically). The deltas are integers
 * because the command rounds them: `toPosition` is idempotent on an integer,
 * so composing two is exact, while a fraction is a rounding question this
 * property has no business deciding.
 */
const step = fc.integer({ min: -400, max: 400 })

/**
 * One coordinate, brought into the range a canvas is drawn in.
 *
 * The schema says `finite`, so the generator draws the whole double range —
 * and additivity is then FALSE, for a reason that belongs to floating point
 * rather than to this command. The first counterexample was a bend at
 * `y = 5e-324` moved by -366 and then +366: the first addition absorbs the
 * denormal entirely, the second brings back a clean 0, while the summed move
 * is (0, 0) and keeps it. Every reachable canvas is orders of magnitude away
 * from that, so the class is excluded here rather than weakening what the
 * property claims. The SHAPES the generator varies — which end is on a node,
 * whether there are bends — are what this is about, and they all survive.
 */
const tame = (value: number): number => Math.round(Math.max(-1e4, Math.min(1e4, value)))

const tameEnd = (end: CanvasLine['from']): CanvasLine['from'] =>
  end.kind === 'point' ? { ...end, point: { x: tame(end.point.x), y: tame(end.point.y) } } : end

const lineCanvasArb: fc.Arbitrary<SpatialCanvas> = canvasLineArbitrary.map((line) => ({
  nodes: [],
  edges: [],
  lines: [
    {
      ...line,
      from: tameEnd(line.from),
      to: tameEnd(line.to),
      ...(line.bends === undefined
        ? {}
        : { bends: line.bends.map((bend) => ({ x: tame(bend.x), y: tame(bend.y) })) }),
    },
  ],
}))

const onlyLine = (canvas: SpatialCanvas): CanvasLine => {
  const line = canvas.lines?.[0]
  if (line === undefined) throw new Error('the generator built a canvas with no line')
  return line
}

describe('move-line properties', () => {
  fcTest.prop([lineCanvasArb, step, step, step, step], withDefaults({ numRuns: 200 }))(
    'two moves are the one move that sums them',
    (canvas, ax, ay, bx, by) => {
      const twice = applyCommand(
        applyCommand(canvas, { kind: 'move-line', id: onlyLine(canvas).id, dx: ax, dy: ay }),
        { kind: 'move-line', id: onlyLine(canvas).id, dx: bx, dy: by },
      )
      const once = applyCommand(canvas, {
        kind: 'move-line',
        id: onlyLine(canvas).id,
        dx: ax + bx,
        dy: ay + by,
      })
      expect(onlyLine(twice)).toEqual(onlyLine(once))
    },
  )

  fcTest.prop([lineCanvasArb, step, step], withDefaults({ numRuns: 200 }))(
    'an end on a node is carried by the node, so a move never touches it',
    (canvas, dx, dy) => {
      const before = onlyLine(canvas)
      const after = onlyLine(applyCommand(canvas, { kind: 'move-line', id: before.id, dx, dy }))
      for (const side of ['from', 'to'] as const) {
        if (before[side].kind === 'node') expect(after[side]).toEqual(before[side])
      }
      // Nothing is added or dropped on the way: a move that lost a bend
      // would still satisfy additivity, since it would lose it both times.
      expect(after.bends?.length).toBe(before.bends?.length)
    },
  )
})
