import {
  canvasCommentArbitrary,
  extensionFacetsArbitrary,
  spatialCanvasArbitrary,
} from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, UndoManager } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  deleteCanvasComment,
  deleteSpatialEdge,
  deleteSpatialNode,
  readFacets,
  readSpatialCanvas,
  withSpatialBatch,
  writeCanvasComment,
  writeFacets,
  writeSpatialCanvas,
  writeSpatialNode,
} from './loro-bridge.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * `-0` and `0` are the same point, and no serialisation this project crosses
 * can tell them apart — the Loro record normalises one to the other exactly as
 * `JSON.stringify` does. The model accepts `-0` because rejecting it would
 * refuse `Math.round(-0.2)`, which the editor really produces; what is not
 * true is that it survives a save, and the example below says so directly.
 */
const zeroNormalised = <T extends { x?: number; y?: number }>(value: T): T => ({
  ...value,
  ...(value.x !== undefined && { x: value.x + 0 }),
  ...(value.y !== undefined && { y: value.y + 0 }),
})

/**
 * The same normalisation for an EDGE, whose `bends` are points too
 * (ADR-0033 slice 4). It is separate rather than folded into the helper above
 * because an edge has no `x`/`y` of its own — what it has is a list of them,
 * and the property found the gap the day bends arrived.
 */
const bendsNormalised = <T extends { bends?: readonly { x: number; y: number }[] }>(edge: T): T =>
  edge.bends === undefined ? edge : { ...edge, bends: edge.bends.map(zeroNormalised) }

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
      expect(byId(result.nodes)).toEqual(byId(canvas.nodes).map(zeroNormalised))
      expect(byId(result.edges)).toEqual(byId(canvas.edges).map(bendsNormalised))
      // The envelope too — routing preferences and the canvas's facets —
      // because this bridge is the path the app saves through, and a JSON
      // round-trip is no evidence a field persists here. Comments are
      // projected from the threads plane and compared in their own tests.
      expect(result.facets).toEqual(canvas.facets)
    },
  )

  it('stores a negative-zero coordinate as zero, because the record cannot carry one', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [{ id: 'n1', type: 'text', text: '', x: -0, y: 1.5, width: 0, height: 0 }],
      edges: [],
    })
    const read = readSpatialCanvas(doc)
    expect(Object.is(read.nodes[0]?.x, 0)).toBe(true)
    // The sub-pixel coordinate beside it DOES survive: what the record cannot
    // carry is the sign of a zero, not the fraction (ADR-0033 slice 4).
    expect(read.nodes[0]?.y).toBe(1.5)
  })

  it('normalises a negative zero in an edge BEND the same way', () => {
    // Reachable rather than theoretical: the bend drag rounds before it
    // writes, and `Math.round(-0.2)` is `-0`. The property found this the day
    // bends became a field; the node case above had been pinned for longer,
    // which is exactly why the edge case needed its own.
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [
        { id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1 },
        { id: 'b', type: 'text', text: '', x: 9, y: 9, width: 1, height: 1 },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b', bends: [{ x: -0, y: 2.5 }] }],
    })
    const bend = readSpatialCanvas(doc).edges[0]?.bends?.[0]
    expect(Object.is(bend?.x, 0)).toBe(true)
    expect(bend?.y).toBe(2.5)
  })

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

// The annotation layer's one reason to exist (ADR-0024): two peers must be
// able to touch DIFFERENT comments — or different FIELDS of the comment
// annotation layer's state — concurrently and have both effects survive a
// merge. `spatialCanvasArbitrary` already attaches 0-3 comments of its own
// (via canvasCommentArbitrary), which would collide with a freshly-generated
// pair's ids at low but nonzero probability and pollute the exact-membership
// assertions below — so these properties seed a clean base canvas (nodes and
// edges only) and add comments only through the fine-grained writer under
// test.
describe('comment concurrency properties (ADR-0024)', () => {
  fcTest.prop(
    [
      spatialCanvasArbitrary,
      fc.uniqueArray(canvasCommentArbitrary, { minLength: 2, maxLength: 2, selector: (c) => c.id }),
    ],
    withDefaults(),
  )(
    'two peers each writeCanvasComment a DIFFERENT comment concurrently: both survive a bidirectional merge',
    (canvas, pair) => {
      const [commentA, commentB] = pair
      const clean = { nodes: canvas.nodes, edges: canvas.edges }
      const base = new LoroDoc()
      writeSpatialCanvas(base, clean)
      const peer = new LoroDoc()
      peer.import(base.export({ mode: 'snapshot' }))

      writeCanvasComment(base, commentA)
      writeCanvasComment(peer, commentB)

      const peerUpdate = peer.export({ mode: 'update' })
      const baseUpdate = base.export({ mode: 'update' })
      base.import(peerUpdate)
      peer.import(baseUpdate)

      const idsOn = (doc: LoroDoc) =>
        (readSpatialCanvas(doc).comments ?? []).map((c) => c.id).sort()
      const expected = [commentA.id, commentB.id].sort()
      expect(idsOn(base)).toEqual(expected)
      expect(idsOn(peer)).toEqual(expected)
    },
  )

  fcTest.prop(
    [
      spatialCanvasArbitrary,
      canvasCommentArbitrary,
      fc.uniqueArray(canvasCommentArbitrary, { minLength: 1, maxLength: 1, selector: (c) => c.id }),
    ],
    withDefaults(),
  )(
    'peer 1 resolves comment A concurrent with peer 2 creating comment B: after bidirectional sync, both effects survive',
    (canvas, seedA, otherPair) => {
      const [commentB] = otherPair
      // commentB must be a different id from A, or the "create" side is
      // silently the exact same rewrite the "resolve" side already made.
      if (commentB.id === seedA.id) return
      const commentA = { ...seedA, resolved: false }
      const clean = { nodes: canvas.nodes, edges: canvas.edges }
      const base = new LoroDoc()
      writeSpatialCanvas(base, clean)
      writeCanvasComment(base, commentA)
      const peer = new LoroDoc()
      peer.import(base.export({ mode: 'snapshot' }))

      writeCanvasComment(base, { ...commentA, resolved: true })
      writeCanvasComment(peer, commentB)

      const peerUpdate = peer.export({ mode: 'update' })
      const baseUpdate = base.export({ mode: 'update' })
      base.import(peerUpdate)
      peer.import(baseUpdate)

      const check = (doc: LoroDoc) => {
        const comments = readSpatialCanvas(doc).comments ?? []
        expect(comments.find((c) => c.id === commentA.id)?.resolved).toBe(true)
        expect(comments.some((c) => c.id === commentB.id)).toBe(true)
      }
      check(base)
      check(peer)
    },
  )
})

// withSpatialBatch equivalence (editor-completeness slice 1): for ANY
// command list drawn from the writer's operations, one batch produces
// the same readSpatialCanvas state as the sequential committing helpers,
// and (when anything was written) exactly one undo step.
type BatchOp =
  | { readonly kind: 'writeNode'; readonly index: number }
  | { readonly kind: 'deleteNode'; readonly index: number }
  | { readonly kind: 'deleteEdge'; readonly index: number }
  | { readonly kind: 'writeComment'; readonly index: number }
  | { readonly kind: 'deleteComment'; readonly index: number }

describe('withSpatialBatch equivalence property', () => {
  fcTest.prop(
    [
      spatialCanvasArbitrary,
      fc.array(
        fc.record({
          kind: fc.constantFrom<
            'writeNode' | 'deleteNode' | 'deleteEdge' | 'writeComment' | 'deleteComment'
          >('writeNode', 'deleteNode', 'deleteEdge', 'writeComment', 'deleteComment'),
          index: fc.nat({ max: 7 }),
        }),
        { maxLength: 6 },
      ),
    ],
    withDefaults(),
  )(
    'one batch ≡ sequential helpers on state, and at most one undo step',
    async (canvas, opSpecs) => {
      const ops: BatchOp[] = opSpecs
      const comments = canvas.comments ?? []
      const apply = {
        writeNode: (index: number) => canvas.nodes[index % Math.max(1, canvas.nodes.length)],
        deleteNode: (index: number) => canvas.nodes[index % Math.max(1, canvas.nodes.length)]?.id,
        deleteEdge: (index: number) => canvas.edges[index % Math.max(1, canvas.edges.length)]?.id,
        writeComment: (index: number) => comments[index % Math.max(1, comments.length)],
        deleteComment: (index: number) => comments[index % Math.max(1, comments.length)]?.id,
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
        } else if (op.kind === 'deleteEdge') {
          const id = apply.deleteEdge(op.index)
          if (id !== undefined) deleteSpatialEdge(sequential, id)
        } else if (op.kind === 'writeComment') {
          const comment = apply.writeComment(op.index)
          if (comment !== undefined) writeCanvasComment(sequential, { ...comment, resolved: true })
        } else {
          const id = apply.deleteComment(op.index)
          if (id !== undefined) deleteCanvasComment(sequential, id)
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
          } else if (op.kind === 'deleteEdge') {
            const id = apply.deleteEdge(op.index)
            if (id !== undefined) writer.deleteEdge(id)
          } else if (op.kind === 'writeComment') {
            const comment = apply.writeComment(op.index)
            if (comment !== undefined) writer.writeComment({ ...comment, resolved: true })
          } else {
            const id = apply.deleteComment(op.index)
            if (id !== undefined) writer.deleteComment(id)
          }
        }
      })

      const stateOf = (doc: LoroDoc) => {
        const value = readSpatialCanvas(doc)
        return {
          nodes: [...value.nodes].sort((a, b) => a.id.localeCompare(b.id)),
          edges: [...value.edges].sort((a, b) => a.id.localeCompare(b.id)),
          comments: [...(value.comments ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
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

// The equivalence property above skips its undo-step assertion whenever
// `undo.canUndo()` is false, which is also the correct outcome for a value-
// identical rewrite (Loro dedupes a `.set()` to unchanged content into no
// diff even though a commit happens) — so that property alone cannot tell
// "batch forgot to commit" apart from "batch committed a no-op". These two
// properties close that gap for the comment writer specifically, each built
// so the write is UNAMBIGUOUSLY a real value change: a brand-new id (the
// base canvas below carries no comments to collide with) or a delete of an
// id already present. Mutation-checked: dropping `wrote = true` from
// `withSpatialBatch`'s `writeComment`/`deleteComment` handlers makes both
// fail (`undo.canUndo()` stays `false` after the batch), and restoring it
// makes both pass again.
describe('withSpatialBatch comment ops always commit (ADR-0024)', () => {
  fcTest.prop([spatialCanvasArbitrary, canvasCommentArbitrary], withDefaults())(
    'a batch that only writes one brand-new comment produces exactly one undo step',
    (canvas, comment) => {
      const clean = { nodes: canvas.nodes, edges: canvas.edges }
      const doc = new LoroDoc()
      writeSpatialCanvas(doc, clean)
      const undo = new UndoManager(doc, { mergeInterval: 0 })
      withSpatialBatch(doc, (writer) => writer.writeComment(comment))
      expect(undo.canUndo()).toBe(true)
      undo.undo()
      expect(undo.canUndo()).toBe(false)
    },
  )

  fcTest.prop([spatialCanvasArbitrary, canvasCommentArbitrary], withDefaults())(
    'a batch that only deletes one comment present in the doc produces exactly one undo step',
    (canvas, comment) => {
      const clean = { nodes: canvas.nodes, edges: canvas.edges }
      const doc = new LoroDoc()
      writeSpatialCanvas(doc, clean)
      writeCanvasComment(doc, comment)
      const undo = new UndoManager(doc, { mergeInterval: 0 })
      withSpatialBatch(doc, (writer) => writer.deleteComment(comment.id))
      expect(undo.canUndo()).toBe(true)
      undo.undo()
      expect(undo.canUndo()).toBe(false)
    },
  )
})
