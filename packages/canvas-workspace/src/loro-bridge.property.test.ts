import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import {
  canvasEdgeArbitrary,
  extensionFacetsArbitrary,
  spatialNodeArbitrary,
} from '@kamiazya/whiteboard-canvas-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { readFacets, readSpatialCanvas, writeFacets, writeSpatialCanvas } from './loro-bridge.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

/**
 * Same construction as canvas-codec's spatial round-trip property
 * (arbitrary edges wired to arbitrary node ids, deduped by edge id) so both
 * packages exercise the identical valid-by-construction SpatialCanvas shape.
 */
const spatialCanvasArbitrary: fc.Arbitrary<SpatialCanvas> = fc
  .array(spatialNodeArbitrary, { maxLength: 4 })
  // nodeIdArbitrary has low entropy at small sizes (e.g. shrinks to " "),
  // so distinct-by-construction node ids need an explicit dedupe — the
  // model schema rejects duplicate node ids.
  .map((nodes) => nodes.filter((node, index) => nodes.findIndex((n) => n.id === node.id) === index))
  .chain((nodes) => {
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
        edges: canvas.edges.filter(
          (edge, index) => canvas.edges.findIndex((e) => e.id === edge.id) === index,
        ),
      }))
  })

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id))
}

describe('loro-bridge properties', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'readSpatialCanvas(writeSpatialCanvas(doc, canvas)) deep-equals canvas up to node/edge order',
    (canvas) => {
      // LoroMap.keys() iteration order is not insertion order — the bridge
      // never promises to preserve node/edge array order, only membership
      // and content (see loro-bridge.test.ts's multi-node cases, which
      // already compare sorted id sets rather than raw array equality).
      const doc = new LoroDoc()
      writeSpatialCanvas(doc, canvas)
      const result = readSpatialCanvas(doc)
      expect(byId(result.nodes)).toEqual(byId(canvas.nodes))
      expect(byId(result.edges)).toEqual(byId(canvas.edges))
    },
  )

  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'writeSpatialCanvas is total: never throws on a valid SpatialCanvas',
    (canvas) => {
      const doc = new LoroDoc()
      expect(() => writeSpatialCanvas(doc, canvas)).not.toThrow()
    },
  )

  fcTest.prop([extensionFacetsArbitrary], withDefaults())(
    'readFacets(writeFacets(doc, facets)) deep-equals facets',
    (facets) => {
      const doc = new LoroDoc()
      writeFacets(doc, facets)
      const result = readFacets(doc)
      expect(result).toEqual(facets)
    },
  )
})
