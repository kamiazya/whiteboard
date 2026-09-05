// @vitest-environment node
// Preventive properties over hitTest — the click-resolution contract the
// editor's selection, drag, edit, and context-menu paths all share. Pins
// the container-yield rule (an unfilled group frame never steals a click
// from a visible content node) across arbitrary arrangements.
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { boxContains, hitTest, type NodeBox } from './geometry.js'

// Ranges chosen for DENSE overlap: with positions in [-50, 50] and sizes in
// [40, 200], most pairs of boxes intersect, and most sampled points land
// inside several boxes at once. A sparse generator makes the container-yield
// property vacuously true (no arrangement ever has a frame above a content
// node under the same point) — verified by mutation: reverting the hitTest
// container rule must turn these properties red.
const boxArb = fc.record({
  x: fc.integer({ min: -50, max: 50 }),
  y: fc.integer({ min: -50, max: 50 }),
  width: fc.integer({ min: 40, max: 200 }),
  height: fc.integer({ min: 40, max: 200 }),
})

const nodeBoxArb = (id: string) =>
  fc
    .record({ box: boxArb, container: fc.boolean() })
    .map(({ box, container }): NodeBox => (container ? { id, container: true, box } : { id, box }))

const arrangement = fc
  .array(nodeBoxArb('n'), { minLength: 0, maxLength: 6 })
  .map((boxes) => boxes.map((entry, i) => ({ ...entry, id: `n${i}` })))

const pointArb = fc.record({
  x: fc.integer({ min: -60, max: 150 }),
  y: fc.integer({ min: -60, max: 150 }),
})

describe('hitTest properties', () => {
  fcTest.prop([arrangement, pointArb], withDefaults())(
    'hits iff some box contains the point, and the hit contains it',
    (boxes, point) => {
      const hit = hitTest(boxes, point)
      const containing = boxes.filter((entry) => boxContains(entry.box, point))
      if (containing.length === 0) {
        expect(hit).toBeUndefined()
      } else {
        const hitBox = boxes.find((entry) => entry.id === hit)
        expect(hitBox).toBeDefined()
        expect(boxContains((hitBox as NodeBox).box, point)).toBe(true)
      }
    },
  )

  fcTest.prop([arrangement, pointArb], withDefaults())(
    'a container never wins while a content node is under the point',
    (boxes, point) => {
      const hit = hitTest(boxes, point)
      const contentUnderPoint = boxes.some(
        (entry) => entry.container !== true && boxContains(entry.box, point),
      )
      if (contentUnderPoint) {
        const hitBox = boxes.find((entry) => entry.id === hit)
        expect(hitBox?.container).not.toBe(true)
      }
    },
  )

  fcTest.prop([arrangement, pointArb], withDefaults())(
    'within its class the topmost (document-order-last) box wins',
    (boxes, point) => {
      const hit = hitTest(boxes, point)
      if (hit === undefined) return
      const hitBox = boxes.find((entry) => entry.id === hit) as NodeBox
      const sameClassContaining = boxes.filter(
        (entry) =>
          (entry.container === true) === (hitBox.container === true) &&
          boxContains(entry.box, point),
      )
      expect(sameClassContaining.at(-1)?.id).toBe(hit)
    },
  )
})
