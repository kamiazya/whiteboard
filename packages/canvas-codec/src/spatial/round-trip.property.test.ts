import {
  canvasEdgeArbitrary,
  spatialNodeArbitrary,
} from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { parseSpatial } from './parse.js'
import { serializeSpatial } from './serialize.js'

const spatialCanvasArbitrary = fc.array(spatialNodeArbitrary, { maxLength: 4 }).chain((nodes) => {
  const ids = nodes.map((node) => node.id)
  const edgeArbitrary =
    ids.length >= 2
      ? fc
          .tuple(fc.constantFrom(...ids), fc.constantFrom(...ids))
          .chain(([fromNode, toNode]) =>
            canvasEdgeArbitrary.map((edge) => ({ ...edge, fromNode, toNode })),
          )
      : fc.constant(undefined)

  return fc
    .array(edgeArbitrary, { maxLength: ids.length >= 2 ? 3 : 0 })
    .map((edges) => ({
      nodes,
      edges: edges.filter((edge): edge is NonNullable<typeof edge> => edge !== undefined),
    }))
    .map((canvas) => ({
      ...canvas,
      // dedupe edge ids: the model schema rejects duplicates
      edges: canvas.edges.filter(
        (edge, index) => canvas.edges.findIndex((e) => e.id === edge.id) === index,
      ),
    }))
})

describe('extended JSON Canvas round-trip property (lossless)', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'parseSpatial(serializeSpatial(x, "extended")) deep-equals x',
    (canvas) => {
      const text = serializeSpatial(canvas, 'extended')
      const result = parseSpatial(text)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(canvas)
    },
  )
})
