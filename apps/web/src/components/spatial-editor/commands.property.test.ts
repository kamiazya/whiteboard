// Metamorphic property for buildFragmentInsertCommand: relative geometry and
// node count survive the remint+offset pipeline regardless of which offset
// mode fires. Mutation-checked by temporarily breaking the offset/remint
// rule in commands.ts and confirming this goes red (recorded in the commit).
import type { ClipboardFragment, SpatialCanvas } from '@kamiazya/whiteboard-model'
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
        nodes: [{ id: 'existing', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
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
