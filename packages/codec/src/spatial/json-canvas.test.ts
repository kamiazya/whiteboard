import { spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fcTest, withDefaults } from '../test-utils/fast-check.js'
import { jsonCanvasDocumentSchema } from './json-canvas.js'

/**
 * This package now declares the JSON Canvas 1.0 wire shape itself, instead of
 * aliasing the model's. The two are meant to be the same shape TODAY — the
 * model has not diverged yet — so the copy's faithfulness is checkable, and
 * these are the checks that make declaring it a relocation rather than a fork.
 *
 * They are temporary by design. When the model gains its first field the
 * format cannot hold, both of these must be DELETED rather than weakened: the
 * round-trip property through `toJsonCanvas`/`fromJsonCanvas` is what carries
 * the claim from then on, and an equivalence test kept alive past that point
 * would be the fork this one exists to rule out.
 */
describe('the wire declaration is a faithful copy of the model it was lifted from', () => {
  it('generates an identical JSON Schema, structurally and totally', () => {
    const options = { target: 'draft-2020-12' } as const
    expect(z.toJSONSchema(jsonCanvasDocumentSchema, options)).toEqual(
      z.toJSONSchema(spatialCanvasSchema, options),
    )
  })

  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'accepts every document the model accepts, with the same parsed value',
    (canvas) => {
      // The behavioural half: refinements — unique ids, edges whose endpoints
      // exist — are invisible to JSON Schema, so the structural check above
      // cannot see them at all.
      const wire = jsonCanvasDocumentSchema.safeParse(canvas)
      const model = spatialCanvasSchema.safeParse(canvas)
      expect(wire.success).toBe(model.success)
      expect(wire.success && wire.data).toEqual(model.success && model.data)
    },
  )

  it('refuses an edge naming a node that is not there, the way the model does', () => {
    const broken = { nodes: [], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] }
    expect(jsonCanvasDocumentSchema.safeParse(broken).success).toBe(false)
    expect(spatialCanvasSchema.safeParse(broken).success).toBe(false)
  })
})
