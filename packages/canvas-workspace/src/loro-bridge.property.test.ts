import {
  extensionFacetsArbitrary,
  spatialCanvasArbitrary,
} from '@kamiazya/whiteboard-canvas-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import {
  deleteSpatialEdge,
  deleteSpatialNode,
  readFacets,
  readSpatialCanvas,
  withSpatialBatch,
  writeFacets,
  writeSpatialCanvas,
  writeSpatialNode,
} from './loro-bridge.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

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
    'readFacets(writeFacets(doc, facets)) deep-equals facets (up to -0 normalization)',
    (facets) => {
      const doc = new LoroDoc()
      writeFacets(doc, facets)
      const result = readFacets(doc)
      // Loro normalizes -0 to 0 during storage; JSON.parse(JSON.stringify())
      // applies the same normalization so we compare against that.
      expect(result).toEqual(JSON.parse(JSON.stringify(facets)))
    },
  )
})

// withSpatialBatch equivalence (editor-completeness slice 1): for ANY
// command list drawn from the writer's four operations, one batch produces
// the same readSpatialCanvas state as the sequential committing helpers,
// and (when anything was written) exactly one undo step.
type BatchOp =
  | { readonly kind: 'writeNode'; readonly index: number }
  | { readonly kind: 'deleteNode'; readonly index: number }
  | { readonly kind: 'deleteEdge'; readonly index: number }

describe('withSpatialBatch equivalence property', () => {
  fcTest.prop(
    [
      spatialCanvasArbitrary,
      fc.array(
        fc.record({
          kind: fc.constantFrom<'writeNode' | 'deleteNode' | 'deleteEdge'>(
            'writeNode',
            'deleteNode',
            'deleteEdge',
          ),
          index: fc.nat({ max: 7 }),
        }),
        { maxLength: 6 },
      ),
    ],
    withDefaults(),
  )(
    'one batch ≡ sequential helpers on state, and at most one undo step',
    async (canvas, opSpecs) => {
      const { UndoManager } = await import('loro-crdt')
      const ops: BatchOp[] = opSpecs
      const apply = {
        writeNode: (index: number) => canvas.nodes[index % Math.max(1, canvas.nodes.length)],
        deleteNode: (index: number) => canvas.nodes[index % Math.max(1, canvas.nodes.length)]?.id,
        deleteEdge: (index: number) => canvas.edges[index % Math.max(1, canvas.edges.length)]?.id,
      }

      const sequential = new LoroDoc()
      writeSpatialCanvas(sequential, canvas)
      const batched = new LoroDoc()
      batched.import(sequential.export({ mode: 'snapshot' }))

      for (const op of ops) {
        if (op.kind === 'writeNode') {
          const node = apply.writeNode(op.index)
          if (node !== undefined) writeSpatialNode(sequential, { ...node, x: node.x + 1 })
        } else if (op.kind === 'deleteNode') {
          const id = apply.deleteNode(op.index)
          if (id !== undefined) deleteSpatialNode(sequential, id)
        } else {
          const id = apply.deleteEdge(op.index)
          if (id !== undefined) deleteSpatialEdge(sequential, id)
        }
      }

      const undo = new UndoManager(batched, { mergeInterval: 0 })
      withSpatialBatch(batched, (writer) => {
        for (const op of ops) {
          if (op.kind === 'writeNode') {
            const node = apply.writeNode(op.index)
            if (node !== undefined) writer.writeNode({ ...node, x: node.x + 1 })
          } else if (op.kind === 'deleteNode') {
            const id = apply.deleteNode(op.index)
            if (id !== undefined) writer.deleteNode(id)
          } else {
            const id = apply.deleteEdge(op.index)
            if (id !== undefined) writer.deleteEdge(id)
          }
        }
      })

      const stateOf = (doc: LoroDoc) => {
        const value = readSpatialCanvas(doc)
        return {
          nodes: [...value.nodes].sort((a, b) => a.id.localeCompare(b.id)),
          edges: [...value.edges].sort((a, b) => a.id.localeCompare(b.id)),
        }
      }
      expect(stateOf(batched)).toEqual(stateOf(sequential))
      if (undo.canUndo()) {
        undo.undo()
        expect(undo.canUndo()).toBe(false)
      }
    },
  )
})
