/**
 * For every key a node patch DOES accept, it accepts what the node stores
 * there.
 *
 * `nodePatchFieldsSchema` is written out by hand beside the node schemas, and
 * its own comment says why: which keys are patchable is a judgement, and that
 * file is where the judgement is recorded. So this does not assert that every
 * field is patchable — `facets` and `embed` are deliberately not, and are
 * written through `wb_facet_set` instead.
 *
 * What is NOT a judgement is the TYPE behind a key that is patchable, and
 * that had already drifted: ADR-0037 slice 4 made geometry a real number
 * while the patch went on declaring `integerSchema`, so the model stored an
 * `x` of 10.5 that `node.patch` refused — and the editor produces exactly
 * that, dragging at sub-pixel positions.
 *
 * The patchable set is read off the schema rather than listed, so a key added
 * to the patch is covered without anyone remembering this file.
 */
import { describe, expect } from 'vitest'
import { nodePatchFieldsSchema } from './proposal.js'
import { fc, fcTest, spatialNodeArbitrary, withDefaults } from './test-utils/index.js'

const PATCHABLE = new Set(Object.keys(nodePatchFieldsSchema.shape))

const patchableOf = (node: object) =>
  Object.fromEntries(Object.entries(node).filter(([key]) => PATCHABLE.has(key)))

describe('a node patch accepts what the node stores', () => {
  fcTest.prop([spatialNodeArbitrary], withDefaults({ numRuns: 200 }))(
    'every drawn node patches cleanly on the keys the patch admits',
    (node) => {
      const result = nodePatchFieldsSchema.safeParse(patchableOf(node))
      expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true)
    },
  )

  fcTest.prop([fc.double({ min: -1e6, max: 1e6, noNaN: true })], withDefaults({ numRuns: 100 }))(
    'a coordinate the model stores is a coordinate the patch takes',
    (x) => {
      expect(nodePatchFieldsSchema.safeParse({ x, y: x }).success).toBe(true)
    },
  )
})
