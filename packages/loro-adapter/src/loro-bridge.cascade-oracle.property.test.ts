/**
 * The node cascade was restructured for cost — one sweep per run of node
 * removals — and must leave exactly the document the per-call version left.
 *
 * The oracle below is the code as it was before that change, copied verbatim
 * apart from names: a per-node cascade over `keys().includes`. What it SHARES
 * with the subject is the write projection (`writeSpatialNode`, the batch's
 * `writeLine`) and the model's `anchoredOnAny`, none of which the change
 * touched — a mutation inside those moves both sides and is out of this
 * property's reach by construction. The board carries comment threads too,
 * and the whole-document comparison holds the cascade to leaving them alone.
 */

import {
  type AnnotationAnchor,
  anchoredOnAny,
  type CanvasEdge,
  type CanvasLine,
  canvasEdgeSchema,
  canvasLineSchema,
  type SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { afterAllFloor, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { readCommentThreads, writeCommentThread, writeThreadMessage } from './comment-threads.js'
import { EDGE_LOCKS_KEY, EDGES_KEY, LINES_KEY, NODE_LOCKS_KEY, NODES_KEY } from './containers.js'
import { sameValue } from './document-envelope-reconcile.js'
import {
  readSpatialCanvas,
  reconcileSpatialCanvas,
  type SpatialBatchWriter,
  setEdgeLock,
  setNodeLock,
  withSpatialBatch,
  writeSpatialCanvas,
} from './loro-bridge.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

type Doc = LoroDoc

// ---------------------------------------------------------------------------
// The oracle: the pre-change functions.
// ---------------------------------------------------------------------------

/** What a case reached; each counts the CASES that reached it at least once. */
type Reach =
  /** A node removal that took at least one edge or line with it. */
  | 'cascades'
  /** A batch write of an edge or line anchored on a node removed earlier in it. */
  | 'writesAfterRemoval'
  /** A reconcile whose node removals are its last writes, so nothing after them sweeps. */
  | 'cascadeLast'
const reached: Record<Reach | 'cases', number> = {
  cases: 0,
  cascades: 0,
  writesAfterRemoval: 0,
  cascadeLast: 0,
}
let thisCase = new Set<Reach>()
function startCase(): void {
  thisCase = new Set()
}
function endCase(): void {
  reached.cases += 1
  for (const reach of thisCase) reached[reach] += 1
}

function oldDropLockInto(doc: Doc, mapKey: string, id: string): void {
  const locksMap = doc.getMap(mapKey)
  if (locksMap.keys().includes(id)) locksMap.delete(id)
}

function oldDeleteNodeCascadeInto(doc: Doc, nodeId: string): boolean {
  const nodesMap = doc.getMap(NODES_KEY)
  if (!nodesMap.keys().includes(nodeId)) return false

  nodesMap.delete(nodeId)
  oldDropLockInto(doc, NODE_LOCKS_KEY, nodeId)
  const ids = new Set([nodeId])
  let swept = 0
  const edgesMap = doc.getMap(EDGES_KEY)
  for (const edgeId of edgesMap.keys()) {
    const parsed = canvasEdgeSchema.safeParse(edgesMap.get(edgeId))
    if (parsed.success && anchoredOnAny(parsed.data, ids)) {
      edgesMap.delete(edgeId)
      oldDropLockInto(doc, EDGE_LOCKS_KEY, edgeId)
      swept += 1
    }
  }
  const linesMap = doc.getMap(LINES_KEY)
  for (const lineId of linesMap.keys()) {
    const parsed = canvasLineSchema.safeParse(linesMap.get(lineId))
    if (parsed.success && anchoredOnAny(parsed.data, ids)) {
      linesMap.delete(lineId)
      oldDropLockInto(doc, EDGE_LOCKS_KEY, lineId)
      swept += 1
    }
  }
  if (swept > 0) thisCase.add('cascades')
  return true
}

function oldDeleteLineInto(doc: Doc, lineId: string): boolean {
  const linesMap = doc.getMap(LINES_KEY)
  if (!linesMap.keys().includes(lineId)) return false
  linesMap.delete(lineId)
  oldDropLockInto(doc, EDGE_LOCKS_KEY, lineId)
  return true
}

function oldDeleteEdgeInto(doc: Doc, edgeId: string): boolean {
  const edgesMap = doc.getMap(EDGES_KEY)
  if (!edgesMap.keys().includes(edgeId)) return false
  edgesMap.delete(edgeId)
  oldDropLockInto(doc, EDGE_LOCKS_KEY, edgeId)
  return true
}

/** The write projection did not change, so the oracle writes through the subject's own. */
function sharedWrites(doc: Doc): Pick<SpatialBatchWriter, 'writeNode' | 'writeEdge' | 'writeLine'> {
  return {
    writeNode: (node) => withSpatialBatch(doc, (w) => w.writeNode(node)),
    writeEdge: (edge) => withSpatialBatch(doc, (w) => w.writeEdge(edge)),
    writeLine: (line) => withSpatialBatch(doc, (w) => w.writeLine(line)),
  }
}

function oldWriter(doc: Doc): SpatialBatchWriter {
  return {
    ...sharedWrites(doc),
    deleteNode: (id) => void oldDeleteNodeCascadeInto(doc, id),
    deleteEdge: (id) => void oldDeleteEdgeInto(doc, id),
    deleteLine: (id) => void oldDeleteLineInto(doc, id),
  }
}

function oldReconcileById<T extends { readonly id: string }>(
  prev: readonly T[],
  next: readonly T[],
  write: (item: T) => void,
  remove: (id: string) => void,
): void {
  const before = new Map(prev.map((item) => [item.id, item]))
  const kept = new Set(next.map((item) => item.id))
  for (const item of next) {
    const was = before.get(item.id)
    if (was === undefined || !sameValue(was, item)) write(item)
  }
  for (const id of before.keys()) if (!kept.has(id)) remove(id)
}

function oldReconcile(doc: Doc, prev: SpatialCanvas, next: SpatialCanvas): void {
  const writer = oldWriter(doc)
  oldReconcileById(prev.nodes, next.nodes, writer.writeNode, writer.deleteNode)
  oldReconcileById(prev.edges, next.edges, writer.writeEdge, writer.deleteEdge)
  oldReconcileById(prev.lines ?? [], next.lines ?? [], writer.writeLine, writer.deleteLine)
  doc.commit()
}

// ---------------------------------------------------------------------------
// Boards.
// ---------------------------------------------------------------------------

const POOL = ['a', 'b', 'c', 'd', 'e'] as const
const ELEMENT_SLOTS = 6
const COMMENT_SLOTS = 5

const nodeIdArb = fc.constantFrom(...POOL)
const pointArb = fc.record({
  x: fc.integer({ min: -9, max: 9 }),
  y: fc.integer({ min: -9, max: 9 }),
})
const edgeEndArb = nodeIdArb.map((node) => ({ node }))
// Weighted toward a node end: the cascade is the subject, and a line with two
// point ends is only the survivor it must leave alone.
const lineEndArb = fc.oneof(
  { weight: 3, arbitrary: nodeIdArb.map((node) => ({ kind: 'node' as const, node })) },
  { weight: 2, arbitrary: pointArb.map((point) => ({ kind: 'point' as const, point })) },
)
const labelArb = fc.option(fc.constantFrom('x', 'y'), { nil: undefined })
const commentSpecArb = fc.record({
  shape: fc.constantFrom('node', 'text', 'region'),
  target: nodeIdArb,
  resolved: fc.boolean(),
  replies: fc.nat({ max: 2 }),
})
const boardArb = fc.record({
  nodes: fc.subarray([...POOL], { minLength: 1 }),
  edges: fc.array(fc.record({ from: edgeEndArb, to: edgeEndArb, label: labelArb }), {
    maxLength: ELEMENT_SLOTS,
  }),
  lines: fc.array(fc.record({ from: lineEndArb, to: lineEndArb }), { maxLength: ELEMENT_SLOTS }),
  nodeLocks: fc.subarray([...POOL]),
  // A lock entry whose value is not `true` reads as unlocked, but a removal
  // still drops it: an older or foreign writer is the only source of one.
  strayLocks: fc.subarray([...POOL], { maxLength: 2 }),
  elementLocks: fc.subarray(
    Array.from({ length: ELEMENT_SLOTS }, (_, i) => [`e${i}`, `l${i}`]).flat(),
    { maxLength: 6 },
  ),
  comments: fc.array(commentSpecArb, { maxLength: COMMENT_SLOTS }),
  dup: fc.option(fc.record({ of: nodeIdArb, key: fc.constantFrom('0dup', 'zdup') }), {
    nil: undefined,
    freq: 4,
  }),
})
type Board = typeof boardArb extends fc.Arbitrary<infer T> ? T : never

const edgeOf = (i: number, e: Board['edges'][number]): CanvasEdge => ({
  id: `e${i}`,
  from: e.from,
  to: e.to,
  ...(e.label === undefined ? {} : { label: e.label }),
})
const lineOf = (i: number, l: Board['lines'][number]): CanvasLine => ({
  id: `l${i}`,
  from: l.from,
  to: l.to,
})

function anchorOf(spec: Board['comments'][number], i: number): AnnotationAnchor {
  switch (spec.shape) {
    case 'text':
      return { kind: 'text', nodeId: spec.target, quote: { exact: 'n' }, start: 0, end: 1 }
    case 'region':
      return { kind: 'spatial', x: i, y: i, width: 4, height: 4 }
    default:
      return { kind: 'spatial', x: i, y: -i, nodeId: spec.target }
  }
}

/** The board's comment threads, anchored on the nodes a cascade removes. */
function seedComments(doc: Doc, specs: Board['comments']): void {
  specs.forEach((spec, i) => {
    const id = `c${i}`
    writeCommentThread(doc, {
      id,
      anchor: anchorOf(spec, i),
      status: spec.resolved ? 'resolved' : 'open',
      messages: [{ id: `${id}-m`, body: `opening ${i}` }],
    })
    for (let r = 0; r < spec.replies; r += 1) {
      writeThreadMessage(doc, id, { id: `r${r}`, body: `reply ${r}` })
    }
  })
}

/** The same board, op for op, in a fresh document. */
function build(board: Board): Doc {
  const doc = new LoroDoc()
  doc.setPeerId(1n)
  writeSpatialCanvas(doc, {
    nodes: board.nodes.map((id, i) =>
      textNode({ id, text: `node ${id}`, x: i * 20, y: 0, width: 10, height: 10 }),
    ),
    edges: board.edges.map((e, i) => edgeOf(i, e)),
    lines: board.lines.map((l, i) => lineOf(i, l)),
  })
  if (board.dup !== undefined) {
    const nodesMap = doc.getMap(NODES_KEY)
    const original = nodesMap.get(board.dup.of)
    if (original !== undefined && typeof original === 'object') {
      nodesMap.set(board.dup.key, { ...(original as Record<string, unknown>), x: 999 })
      doc.commit()
    }
  }
  for (const id of board.nodeLocks) setNodeLock(doc, id, true)
  if (board.strayLocks.length > 0) {
    for (const id of board.strayLocks) doc.getMap(NODE_LOCKS_KEY).set(id, 'stale')
    doc.commit()
  }
  for (const id of board.elementLocks) setEdgeLock(doc, id, true)
  seedComments(doc, board.comments)
  return doc
}

function expectSameDocument(subject: Doc, oracle: Doc): void {
  expect(subject.toJSON()).toEqual(oracle.toJSON())
  expect(readCommentThreads(subject)).toEqual(readCommentThreads(oracle))
  expect(readSpatialCanvas(subject)).toEqual(readSpatialCanvas(oracle))
}

// ---------------------------------------------------------------------------
// Edits.
// ---------------------------------------------------------------------------

const reconcileEditArb = fc.record({
  removeNodes: fc.subarray([...POOL], { minLength: 1 }),
  moveNodes: fc.subarray([...POOL]),
  dropEdges: fc.array(fc.boolean(), { minLength: ELEMENT_SLOTS, maxLength: ELEMENT_SLOTS }),
  relabelEdges: fc.array(fc.boolean(), { minLength: ELEMENT_SLOTS, maxLength: ELEMENT_SLOTS }),
  // Keeping an element anchored on a removed node in `next` is what a stale
  // or careless caller sends; the cascade must treat it exactly as before.
  keepAnchored: fc.boolean(),
  // Everything but the nodes left exactly as it was read, so the node pass's
  // removals are the reconcile's last writes.
  onlyNodes: fc.boolean(),
})
type ReconcileEdit = typeof reconcileEditArb extends fc.Arbitrary<infer T> ? T : never

function nextOf(prev: SpatialCanvas, edit: ReconcileEdit): SpatialCanvas {
  const removed = new Set<string>(edit.removeNodes)
  const moved = new Set<string>(edit.moveNodes)
  const survives = (el: CanvasEdge | CanvasLine) => edit.keepAnchored || !anchoredOnAny(el, removed)
  const slot = (id: string) => Number(id.slice(1))
  const edges = prev.edges
    .filter((edge) => !edit.dropEdges[slot(edge.id)] && survives(edge))
    .map((edge) => {
      if (!edit.relabelEdges[slot(edge.id)]) return edge
      const { label, ...rest } = edge
      return label === undefined ? { ...rest, label: 'z' } : rest
    })
  const lines = (prev.lines ?? []).filter(
    (line) => !edit.dropEdges[slot(line.id)] && survives(line),
  )
  const nodes = prev.nodes
    .filter((node) => !removed.has(node.id))
    .map((node) => (moved.has(node.id) ? { ...node, x: node.x + 1 } : node))
  if (edit.onlyNodes) return { ...prev, nodes }
  return {
    nodes,
    edges,
    ...(lines.length > 0 ? { lines } : {}),
  }
}

const batchOpArb = fc.oneof(
  { weight: 5, arbitrary: fc.record({ op: fc.constant('deleteNode' as const), id: nodeIdArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('writeNode' as const), id: nodeIdArb }) },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant('writeEdge' as const),
      slot: fc.nat({ max: ELEMENT_SLOTS - 1 }),
      from: edgeEndArb,
      to: edgeEndArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('deleteEdge' as const),
      slot: fc.nat({ max: ELEMENT_SLOTS - 1 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant('writeLine' as const),
      slot: fc.nat({ max: ELEMENT_SLOTS - 1 }),
      from: lineEndArb,
      to: lineEndArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('deleteLine' as const),
      slot: fc.nat({ max: ELEMENT_SLOTS - 1 }),
    }),
  },
)
type BatchOp = typeof batchOpArb extends fc.Arbitrary<infer T> ? T : never

function applyOps(writer: SpatialBatchWriter, ops: readonly BatchOp[]): void {
  for (const op of ops) {
    switch (op.op) {
      case 'deleteNode':
        writer.deleteNode(op.id)
        break
      case 'writeNode':
        writer.writeNode(textNode({ id: op.id, text: 'again', x: 5, y: 5, width: 10, height: 10 }))
        break
      case 'writeEdge':
        writer.writeEdge({ id: `e${op.slot}`, from: op.from, to: op.to })
        break
      case 'deleteEdge':
        writer.deleteEdge(`e${op.slot}`)
        break
      case 'writeLine':
        writer.writeLine({ id: `l${op.slot}`, from: op.from, to: op.to })
        break
      case 'deleteLine':
        writer.deleteLine(`l${op.slot}`)
        break
    }
  }
}

/** How many edge/line writes in `ops` name a node an earlier op in the same batch removed. */
function writesAfterRemoval(board: Board, ops: readonly BatchOp[]): number {
  const present = new Set<string>(board.nodes)
  const removed = new Set<string>()
  let count = 0
  for (const op of ops) {
    if (op.op === 'deleteNode' && present.has(op.id)) {
      present.delete(op.id)
      removed.add(op.id)
    } else if (op.op === 'writeNode') present.add(op.id)
    else if ((op.op === 'writeEdge' || op.op === 'writeLine') && anchoredOnAny(op, removed)) {
      count += 1
    }
  }
  return count
}

// A property over a document per case is slow per run; this is a ceiling,
// sized well above a measured run, that only decides whether it may finish.
const PROPERTY_TIMEOUT_MS = 60_000

// Fractions of the cases (both properties, 200 each) that reached each
// arrangement, measured over five runs: cascades 0.51-0.55,
// writesAfterRemoval 0.10-0.13, cascadeLast 0.22-0.24. Each floor sits well
// under the lowest reading, so it trips on a generator that stopped producing
// the arrangement rather than on a lean draw.
const FLOORS: Record<Reach, number> = {
  cascades: 0.3,
  writesAfterRemoval: 0.05,
  cascadeLast: 0.1,
}

const RECONCILE_TITLE = 'a reconcile leaves the document the per-node cascade left'
const BATCH_TITLE = 'a batch leaves the document the per-node cascade left'

describe('the batched node cascade', () => {
  fcTest.prop([boardArb, reconcileEditArb], withDefaults())(
    RECONCILE_TITLE,
    (board: Board, edit: ReconcileEdit) => {
      const subject = build(board)
      const oracle = build(board)
      const prev = readSpatialCanvas(subject)
      expect(readSpatialCanvas(oracle)).toEqual(prev)
      const next = nextOf(prev, edit)

      startCase()
      const removed = new Set<string>(edit.removeNodes)
      const written = [...next.edges, ...(next.lines ?? [])].filter(
        (el) =>
          anchoredOnAny(el, removed) &&
          ![...prev.edges, ...(prev.lines ?? [])].some((was) => sameValue(was, el)),
      )
      if (written.length > 0) thisCase.add('writesAfterRemoval')
      if (
        edit.onlyNodes &&
        [...prev.edges, ...(prev.lines ?? [])].some((el) => anchoredOnAny(el, removed))
      ) {
        thisCase.add('cascadeLast')
      }
      reconcileSpatialCanvas(subject, prev, next)
      oldReconcile(oracle, prev, next)

      expectSameDocument(subject, oracle)
      endCase()
    },
    PROPERTY_TIMEOUT_MS,
  )

  fcTest.prop([boardArb, fc.array(batchOpArb, { maxLength: 16 })], withDefaults())(
    BATCH_TITLE,
    (board: Board, ops: BatchOp[]) => {
      const subject = build(board)
      const oracle = build(board)

      startCase()
      if (writesAfterRemoval(board, ops) > 0) thisCase.add('writesAfterRemoval')
      withSpatialBatch(subject, (writer) => applyOps(writer, ops))
      applyOps(oldWriter(oracle), ops)
      oracle.commit()

      expectSameDocument(subject, oracle)
      endCase()
    },
    PROPERTY_TIMEOUT_MS,
  )

  afterAllFloor([RECONCILE_TITLE, BATCH_TITLE], () => {
    expect(reached.cases).toBeGreaterThan(0)
    for (const [reach, floor] of Object.entries(FLOORS)) {
      expect(reached[reach as Reach] / reached.cases, reach).toBeGreaterThanOrEqual(floor)
    }
  })
})
