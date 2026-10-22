import {
  anchoredOnAny,
  type CanvasComment,
  type CanvasEdge,
  type CanvasLine,
  canvasEdgeSchema,
  canvasLineSchema,
  type SpatialCanvas,
  type SpatialNode,
  spatialNodeSchema,
  storedTagsSchema,
} from '@kamiazya/whiteboard-model'
import { readCanvasComments } from './annotations.js'
import { deleteCommentInto, writeCommentInto } from './canvas-comment-write.js'
import { migrateCanvasCommentsToThreads } from './comment-threads.js'
import {
  CANVAS_KEY,
  CANVAS_TAGS_FIELD,
  COMMENTS_KEY,
  CORE_KEY,
  DOCUMENT_KEY,
  type DocumentContainers,
  EDGE_LOCKS_KEY,
  EDGES_KEY,
  FACETS_KEY,
  type Fields,
  LINES_KEY,
  MARKDOWN_BODY_KEY,
  NODE_LOCKS_KEY,
  NODES_KEY,
  PROPOSALS_KEY,
  THREADS_KEY,
  TRUST_KEY,
} from './containers.js'
import {
  CANVAS_FACETS_FIELD,
  countUnreadableCanvasFacets,
  readCanvasFacets,
  sameValue,
  writeCanvasFacetsField,
} from './document-envelope-reconcile.js'
import { LEGACY_EXTENSION_FIELD, liftLegacyExtension, liftStoredNode } from './legacy-lifts.js'
import { refuseReservedKey } from './reserved-key-write.js'

/** The board's own tags: one value under its own key, like the facets. */
const TAGS_FIELD = CANVAS_TAGS_FIELD
/** The board's tags, read verbatim; a malformed value costs the tags alone. */
function readCanvasTags(doc: DocumentContainers): string[] | undefined {
  const parsed = storedTagsSchema.safeParse(doc.getMap(CANVAS_KEY).get(TAGS_FIELD))
  return parsed.success ? parsed.data : undefined
}
/**
 * Drops a removed element's lock entry. Every node/edge removal path owes
 * this call — an entry left behind for an id the canvas no longer has would
 * be inherited by a later element reminted onto that id.
 */
function dropLockInto(doc: DocumentContainers, mapKey: string, id: string): void {
  const locksMap = doc.getMap(mapKey)
  if (locksMap.get(id) !== undefined) locksMap.delete(id)
}
function nodeToFields(node: SpatialNode): Fields {
  // Refuse non-finite geometry LOUDLY: readSpatialCanvas round-trips every
  // node through the Zod schema and silently drops failures, so a NaN or
  // Infinity written here would delete the node for every reader — every
  // synced peer, undo-proof, with no signal anywhere. A thrown error at
  // the buggy call site is the only place this class of caller bug is
  // still visible.
  for (const [field, value] of [
    ['x', node.x],
    ['y', node.y],
    ['width', node.width],
    ['height', node.height],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `spatial node "${node.id}" has a non-finite ${field} (${value}); geometry must be finite`,
      )
    }
  }
  const fields: Fields = {
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  }
  if (node.color !== undefined) fields.color = node.color
  if (node.embed !== undefined) fields.embed = node.embed
  if (node.facets !== undefined) fields.facets = node.facets
  // One value, like `bends`: concurrent retagging converges on one set.
  if (node.tags !== undefined) fields.tags = node.tags

  // What a node SHOWS is one field now, so there is no kind to switch on:
  // absence is the frame, and the frame's own fields ride beside it.
  if (node.resource !== undefined) fields.resource = node.resource
  if (node.label !== undefined) fields.label = node.label
  if (node.background !== undefined) fields.background = node.background
  if (node.backgroundStyle !== undefined) fields.backgroundStyle = node.backgroundStyle
  return fields
}

function edgeToFields(edge: CanvasEdge): Fields {
  const fields: Fields = {
    id: edge.id,
    // An ENDPOINT is one value, for the reason `bends` is: it is one thing
    // with one meaning, so last-writer-wins per key is the whole merge story.
    // Two peers re-attaching the same end concurrently should converge on an
    // end one of them chose, never on a half of each.
    from: edge.from,
    to: edge.to,
  }
  if (edge.color !== undefined) fields.color = edge.color
  if (edge.label !== undefined) fields.label = edge.label
  // Bends are a plain array of plain objects, so Loro stores them as ONE
  // value: the whole path is last-writer-wins, which is what a dragged path
  // wants — two people reshaping one edge concurrently should not end up
  // with a interleaved third path neither drew.
  if (edge.bends !== undefined) fields.bends = edge.bends
  if (edge.facets !== undefined) fields.facets = edge.facets
  if (edge.tags !== undefined) fields.tags = edge.tags
  return fields
}

/**
 * A LINE's fields. Identical in shape to an edge's, because the split is about
 * what the element MEANS rather than what it is allowed to carry — the one
 * difference is that an end may be a bare point, and an end is one value here
 * either way.
 */
function lineToFields(line: CanvasLine): Fields {
  const fields: Fields = { id: line.id, from: line.from, to: line.to }
  if (line.color !== undefined) fields.color = line.color
  if (line.label !== undefined) fields.label = line.label
  if (line.bends !== undefined) fields.bends = line.bends
  if (line.facets !== undefined) fields.facets = line.facets
  return fields
}

export function writeSpatialCanvas(doc: DocumentContainers, canvas: SpatialCanvas): void {
  // Asked of the whole canvas before the first op, so a refusal keeps nothing.
  refuseReservedKey(CANVAS_KEY, canvas)
  const nodesMap = doc.getMap(NODES_KEY)
  const edgesMap = doc.getMap(EDGES_KEY)
  // Deleted rather than left behind when the canvas drops it: a canvas that
  // returned to the default must stop rendering a preference the author
  // turned off. Comments are split OUT of the envelope value first — see
  // COMMENTS_KEY for why they must not ride the whole-value LWW write.
  const canvasMap = doc.getMap(CANVAS_KEY)
  const { comments } = canvas
  writeOptionalField(canvasMap, CANVAS_FACETS_FIELD, canvas.facets)
  writeOptionalField(canvasMap, TAGS_FIELD, canvas.tags)
  // A write converges the record — but only when there is something to
  // converge. An unconditional delete is one oplog op per save forever, on
  // every document that never had the old key: measured at +10000 bytes on
  // the growth scoreboard, which is what caught it.
  if (canvasMap.get(LEGACY_EXTENSION_FIELD) !== undefined) {
    canvasMap.delete(LEGACY_EXTENSION_FIELD)
  }

  // Before the incoming set is applied, so a legacy entry the resync omits is
  // migrated and THEN dropped by the sweep below rather than surviving it.
  migrateCanvasCommentsToThreads(doc)
  const threadsMap = doc.getMap(THREADS_KEY)
  const existingCommentIds = new Set<string>(threadsMap.keys())
  for (const comment of comments ?? []) {
    existingCommentIds.delete(comment.id)
    writeCommentInto(doc, comment)
  }
  // A resync states the whole truth, comments included.
  for (const id of existingCommentIds) threadsMap.delete(id)

  // Two phases, in this order, because the op order is part of the bytes:
  // every collection's writes first, then every collection's removals.
  const linesMap = doc.getMap(LINES_KEY)
  const staleNodes = setEvery(nodesMap, canvas.nodes, nodeToFields)
  const staleEdges = setEvery(edgesMap, canvas.edges, edgeToFields)
  const staleLines = setEvery(linesMap, canvas.lines ?? [], lineToFields)

  // A resync is the second removal path, alongside deleteSpatialNode/Edge —
  // so it owes the same lock cascade. Lines share the EDGE lock plane rather
  // than getting one of their own: a lock is keyed by element id, ids are
  // unique across both collections, and a second plane would be a second
  // place for a lock to be orphaned.
  dropEvery(doc, nodesMap, staleNodes, NODE_LOCKS_KEY)
  dropEvery(doc, edgesMap, staleEdges, EDGE_LOCKS_KEY)
  dropEvery(doc, linesMap, staleLines, EDGE_LOCKS_KEY)
  doc.commit()
}

/**
 * Removes every node, edge and line, with their locks, and nothing else. Not
 * the resync with an empty canvas: that states the whole truth, so it would
 * also delete every comment thread and the canvas's own tags and facets. A
 * map with nothing in it costs no op.
 */
export function clearSpatialElementsInto(doc: DocumentContainers): void {
  const nodesMap = doc.getMap(NODES_KEY)
  const edgesMap = doc.getMap(EDGES_KEY)
  const linesMap = doc.getMap(LINES_KEY)
  dropEvery(doc, nodesMap, new Set(nodesMap.keys()), NODE_LOCKS_KEY)
  dropEvery(doc, edgesMap, new Set(edgesMap.keys()), EDGE_LOCKS_KEY)
  dropEvery(doc, linesMap, new Set(linesMap.keys()), EDGE_LOCKS_KEY)
}

/**
 * A canvas field set when present, and removed when absent — but only when
 * there is something to remove. A canvas that returned to the default must
 * stop rendering a preference the author turned off, while one that never had
 * it should not pay an oplog op per save: measured on the growth scoreboard,
 * which is the only thing that says so.
 */
function writeOptionalField(map: CanvasMap, field: string, value: unknown): void {
  if (value !== undefined) map.set(field, value as Parameters<CanvasMap['set']>[1])
  else if (map.get(field) !== undefined) map.delete(field)
}

/**
 * Set every incoming element, answering the ids that were there before and
 * are not incoming — read BEFORE the writes, and in the map's own order, so
 * the removals that follow happen in the order they always have.
 */
function setEvery<T extends { readonly id: string }>(
  map: CanvasMap,
  items: readonly T[],
  toFields: (item: T) => unknown,
): Set<string> {
  const stale = new Set<string>(map.keys())
  for (const item of items) {
    stale.delete(item.id)
    map.set(item.id, toFields(item) as Parameters<CanvasMap['set']>[1])
  }
  return stale
}

/** Remove each stale element, and the lock that named it. */
function dropEvery(
  doc: DocumentContainers,
  map: CanvasMap,
  stale: ReadonlySet<string>,
  locksKey: string,
): void {
  for (const id of stale) {
    map.delete(id)
    dropLockInto(doc, locksKey, id)
  }
}

// Non-committing internals shared by the single committing helpers below
// and `withSpatialBatch`'s writer, so field projection and the delete
// cascade can never drift between the two paths.
function writeNodeInto(doc: DocumentContainers, node: SpatialNode): void {
  refuseReservedKey(NODES_KEY, node)
  doc.getMap(NODES_KEY).set(node.id, nodeToFields(node))
}

function writeEdgeInto(doc: DocumentContainers, edge: CanvasEdge): void {
  refuseReservedKey(EDGES_KEY, edge)
  doc.getMap(EDGES_KEY).set(edge.id, edgeToFields(edge))
}

/**
 * Removes one node and its lock, and NOT what is anchored on it — every
 * caller follows with `sweepAnchoredInto`. Returns false (writing nothing)
 * when the node id is absent.
 */
function deleteNodeInto(doc: DocumentContainers, nodeId: string): boolean {
  const nodesMap = doc.getMap(NODES_KEY)
  if (nodesMap.get(nodeId) === undefined) return false
  nodesMap.delete(nodeId)
  dropLockInto(doc, NODE_LOCKS_KEY, nodeId)
  return true
}

/**
 * Removes every edge and line anchored on one of `ids`, with its lock.
 *
 * Takes a SET so a run of node removals pays one pass: every edge and line is
 * read across the wasm boundary and schema-parsed, and doing that once per
 * removed node made clearing a board quadratic.
 *
 * The test is the model's `anchoredOnAny` — the same definition the
 * editor's command, the proposal adopt and the agent's `node.remove` apply —
 * over BOTH collections an end can name a node from. It followed edges
 * alone for a while, so a box deleted in the editor left its ink anchored to
 * nothing in the persisted document while the canvas on screen showed the
 * ink gone, and the next agent read of the document was refused. Lines
 * share the edge lock plane (see `writeSpatialCanvas`), so a cascaded line's
 * lock goes the way a cascaded edge's does.
 */
function sweepAnchoredInto(doc: DocumentContainers, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return
  const edgesMap = doc.getMap(EDGES_KEY)
  for (const edgeId of edgesMap.keys()) {
    const parsed = canvasEdgeSchema.safeParse(liftLegacyExtension(edgesMap.get(edgeId)))
    if (parsed.success && anchoredOnAny(parsed.data, ids)) {
      edgesMap.delete(edgeId)
      dropLockInto(doc, EDGE_LOCKS_KEY, edgeId)
    }
  }
  const linesMap = doc.getMap(LINES_KEY)
  for (const lineId of linesMap.keys()) {
    const parsed = canvasLineSchema.safeParse(linesMap.get(lineId))
    if (parsed.success && anchoredOnAny(parsed.data, ids)) {
      linesMap.delete(lineId)
      dropLockInto(doc, EDGE_LOCKS_KEY, lineId)
    }
  }
}

function writeLineInto(doc: DocumentContainers, line: CanvasLine): void {
  refuseReservedKey(LINES_KEY, line)
  doc.getMap(LINES_KEY).set(line.id, lineToFields(line))
}

/** Returns false (writing nothing) when the line id is absent. */
function deleteLineInto(doc: DocumentContainers, lineId: string): boolean {
  const linesMap = doc.getMap(LINES_KEY)
  if (linesMap.get(lineId) === undefined) return false
  linesMap.delete(lineId)
  dropLockInto(doc, EDGE_LOCKS_KEY, lineId)
  return true
}

/** Returns false (writing nothing) when the edge id is absent. */
function deleteEdgeInto(doc: DocumentContainers, edgeId: string): boolean {
  const edgesMap = doc.getMap(EDGES_KEY)
  if (edgesMap.get(edgeId) === undefined) return false
  edgesMap.delete(edgeId)
  dropLockInto(doc, EDGE_LOCKS_KEY, edgeId)
  return true
}

/**
 * Writes exactly one node's LoroMap entry, leaving every other node/edge in
 * the doc untouched. This is the node-level CRDT merge granularity a full
 * `writeSpatialCanvas` resync would discard: a concurrent peer edit to a
 * different node survives a merge against this write. Reuses the same
 * `nodeToFields` field-projection `writeSpatialCanvas` uses, so a
 * fine-grained caller (e.g. a debounced editor commit) can never drift from
 * the full-resync encoding.
 */
export function writeSpatialNode(doc: DocumentContainers, node: SpatialNode): void {
  writeNodeInto(doc, node)
  doc.commit()
}

/**
 * Edge counterpart to `writeSpatialNode` — see its doc comment.
 */
export function writeSpatialEdge(doc: DocumentContainers, edge: CanvasEdge): void {
  writeEdgeInto(doc, edge)
  doc.commit()
}

/**
 * Deletes one node's LoroMap entry AND every edge whose fromNode/toNode
 * referenced it, in a single `doc.commit()` — a cascading edge-integrity
 * invariant this bridge enforces so `readSpatialCanvas` never returns an
 * edge with a dangling endpoint. One commit (not one commit per removal)
 * is what lets a single `UndoManager` step restore the node together with
 * its edges, rather than leaving one half of the deletion undone.
 * Idempotent and a no-op (no commit) for an id absent from the doc.
 */
export function deleteSpatialNode(doc: DocumentContainers, nodeId: string): void {
  if (!deleteNodeInto(doc, nodeId)) return
  sweepAnchoredInto(doc, new Set([nodeId]))
  doc.commit()
}

/**
 * Edge counterpart to `deleteSpatialNode` — removes exactly one edge, no
 * cascade needed since an edge has no dependents of its own.
 */
export function deleteSpatialEdge(doc: DocumentContainers, edgeId: string): void {
  if (deleteEdgeInto(doc, edgeId)) doc.commit()
}

/**
 * Make an id-keyed collection in the doc equal `next`, given it currently
 * equals `prev`: write what is new or changed, delete what is gone. An
 * unchanged element writes nothing, which is what keeps an identical
 * reconcile from committing.
 */
function reconcileById<T extends { readonly id: string }>(
  prev: readonly T[],
  next: readonly T[],
  write: (item: T) => void,
  remove: (id: string) => void,
): void {
  const before = new Map(prev.map((item) => [item.id, item]))
  const kept = new Set(next.map((item) => item.id))
  for (const item of next) {
    const was = before.get(item.id)
    // An early-out, not the guarantee: Loro records no op for a `set` of an
    // identical value on its own. This skips the field projection work.
    if (was === undefined || !sameValue(was, item)) write(item)
  }
  for (const id of before.keys()) if (!kept.has(id)) remove(id)
}

/** A canvas field set to `value`, or removed when there is none. */
function setOrDelete(map: CanvasMap, field: string, value: unknown): void {
  if (value === undefined) map.delete(field)
  else map.set(field, value as Parameters<CanvasMap['set']>[1])
}

type CanvasMap = ReturnType<DocumentContainers['getMap']>

/**
 * Applies `next` to the stored canvas as a VISIBLE-diff against `prev`:
 * writes only entries that changed, deletes only ids the caller could SEE
 * in `prev` — and therefore never touches a record the current schema
 * cannot read. That is the property `writeSpatialCanvas`'s whole-truth
 * resync deliberately does not have, and it is load-bearing for a REPLICA:
 * a resync's silent deletion of an unknown-version record would become an
 * op that SHIPS, erasing a newer client's node on the keeper.
 *
 * `prev` must be the canvas the edit started from (what `readSpatialCanvas`
 * answered), not an older snapshot — a stale `prev` under-reports deletions
 * and over-reports changes, both of which stay safe but write more ops than
 * needed. Node/edge/comment writes share one commit; the envelope (the
 * non-comment `x-whiteboard` fields) is a single LWW value and is only
 * touched when it visibly changed.
 */
export function reconcileSpatialCanvas(
  doc: DocumentContainers,
  prev: SpatialCanvas,
  next: SpatialCanvas,
): void {
  if (reconcileSpatialCanvasInto(doc, prev, next)) doc.commit()
}

/**
 * The reconcile itself, without the commit — see `withDocumentBatch`. Answers
 * whether it wrote anything, so a caller that owns the commit boundary can
 * leave an unchanged canvas out of it.
 */
export function reconcileSpatialCanvasInto(
  doc: DocumentContainers,
  prev: SpatialCanvas,
  next: SpatialCanvas,
): boolean {
  // Asked of the whole canvas before the first op, so a refusal keeps
  // nothing; linear, like the per-element comparison below.
  refuseReservedKey(CANVAS_KEY, next)
  let wrote = false
  const { writer, settle } = spatialBatchWriter(doc, () => {
    wrote = true
  })
  // Order is load-bearing: a node's delete cascades to its edges, so the
  // node pass runs before the edge pass exactly as it always has. Its
  // removals come last in that pass, so they share one sweep.
  reconcileById(prev.nodes, next.nodes, writer.writeNode, writer.deleteNode)
  reconcileById(prev.edges, next.edges, writer.writeEdge, writer.deleteEdge)
  reconcileById(prev.lines ?? [], next.lines ?? [], writer.writeLine, writer.deleteLine)
  reconcileById(prev.comments ?? [], next.comments ?? [], writer.writeComment, writer.deleteComment)
  settle()

  const facetsMoved = !sameValue(prev.facets, next.facets)
  const tagsMoved = !sameValue(prev.tags, next.tags)
  if (!facetsMoved && !tagsMoved) return wrote
  const canvasMap = doc.getMap(CANVAS_KEY)
  if (facetsMoved) writeCanvasFacetsField(doc, next.facets)
  if (tagsMoved) setOrDelete(canvasMap, TAGS_FIELD, next.tags)
  return true
}

/** Uncommitted spatial writes scoped to one `withSpatialBatch` call. */
export interface SpatialBatchWriter {
  writeNode(node: SpatialNode): void
  writeEdge(edge: CanvasEdge): void
  /** Same edge-cascade as `deleteSpatialNode`; absent ids write nothing. */
  deleteNode(nodeId: string): void
  deleteEdge(edgeId: string): void
  /** Ink counterpart of writeEdge/deleteEdge; a line's lock shares the edge plane. */
  writeLine(line: CanvasLine): void
  deleteLine(lineId: string): void
  /** Comment counterpart of writeNode/writeEdge — create AND update (an
   * id-keyed rewrite), matching `writeCanvasComment`. */
  writeComment(comment: CanvasComment): void
  deleteComment(commentId: string): void
}

/**
 * The writes `withSpatialBatch` and the reconcile share; `markWrote` fires on
 * each that changed the doc.
 *
 * A node removal's cascade is DEFERRED to the next write of any other kind,
 * or to `settle()`, which the owner calls once the writes are done — so a
 * run of node removals sweeps the edges and lines once. Deferring no further
 * than the next write keeps every write seeing the canvas it always saw: an
 * edge written after its node was removed survives, as it did when each
 * removal swept at once.
 */
function spatialBatchWriter(
  doc: DocumentContainers,
  markWrote: () => void,
): { writer: SpatialBatchWriter; settle: () => void } {
  const removedNodes = new Set<string>()
  const settle = (): void => {
    sweepAnchoredInto(doc, removedNodes)
    removedNodes.clear()
  }
  const writer: SpatialBatchWriter = {
    writeNode(node) {
      settle()
      writeNodeInto(doc, node)
      markWrote()
    },
    writeEdge(edge) {
      settle()
      writeEdgeInto(doc, edge)
      markWrote()
    },
    deleteNode(nodeId) {
      if (!deleteNodeInto(doc, nodeId)) return
      removedNodes.add(nodeId)
      markWrote()
    },
    deleteEdge(edgeId) {
      settle()
      if (deleteEdgeInto(doc, edgeId)) markWrote()
    },
    writeLine(line) {
      settle()
      writeLineInto(doc, line)
      markWrote()
    },
    deleteLine(lineId) {
      settle()
      if (deleteLineInto(doc, lineId)) markWrote()
    },
    writeComment(comment) {
      settle()
      writeCommentInto(doc, comment)
      markWrote()
    },
    deleteComment(commentId) {
      settle()
      if (deleteCommentInto(doc, commentId)) markWrote()
    },
  }
  return { writer, settle }
}

/**
 * Runs every write in `fn` inside ONE Loro commit — one `UndoManager`
 * step, one local-update payload. N=1 is byte-identical to the
 * corresponding single committing helper, and a batch that writes nothing
 * (all deletes of absent ids) commits nothing, preserving the helpers'
 * no-op semantics. (Loro's `UndoManager.groupStart()/groupEnd()` was
 * considered and rejected: a remote import received mid-group can split
 * the group, while a single commit is indivisible.)
 *
 * Error contract (matching this bridge's commit-last convention): if `fn`
 * throws, NOTHING is committed — the error is rethrown and the partial
 * uncommitted ops stay pending on the doc (visible to readers; commit is
 * an undo/sync boundary, not a visibility boundary). The caller must then
 * converge with a committing write — document-sync-session's documented
 * fallback (`writeSpatialCanvas(doc, next)`) does exactly this, absorbing
 * the pending ops into one converged commit. Never follow a thrown batch
 * with an UNRELATED commit on the same doc: the pending ops would be
 * silently absorbed into that step.
 */
export function withSpatialBatch(
  doc: DocumentContainers,
  fn: (writer: SpatialBatchWriter) => void,
): void {
  let wrote = false
  const { writer, settle } = spatialBatchWriter(doc, () => {
    wrote = true
  })
  try {
    fn(writer)
  } finally {
    // On a throw too: the removals `fn` already made were cascaded before it
    // threw when each swept at once, and the pending ops a caller converges
    // from must still hold no edge anchored on a removed node.
    settle()
  }
  // Success path only — a finally-commit would break the error contract
  // above (the session fallback's own commit must stay the only one).
  if (wrote) doc.commit()
}

function readLocks(doc: DocumentContainers, mapKey: string): ReadonlySet<string> {
  const locksMap = doc.getMap(mapKey)
  const locked = new Set<string>()
  for (const id of locksMap.keys()) {
    if (locksMap.get(id) === true) locked.add(id)
  }
  return locked
}

function setLock(doc: DocumentContainers, mapKey: string, id: string, locked: boolean): void {
  const locksMap = doc.getMap(mapKey)
  if ((locksMap.get(id) === true) === locked) return
  if (locked) locksMap.set(id, true)
  else locksMap.delete(id)
  doc.commit()
}

/**
 * Node ids the user has locked. Lock is an EDITOR affordance, not canvas
 * content: it lives in its own map so it never reaches `readSpatialCanvas`
 * — and therefore never reaches an export, a render, or a JSON Canvas
 * file, which is what keeps the stored document spec-clean.
 */
export function readNodeLocks(doc: DocumentContainers): ReadonlySet<string> {
  return readLocks(doc, NODE_LOCKS_KEY)
}

/**
 * Locks or unlocks one node. Writing the value a node already has is a
 * no-op (no commit, no undo step), matching this bridge's convention that
 * nothing-changed writes stay out of history.
 */
export function setNodeLock(doc: DocumentContainers, nodeId: string, locked: boolean): void {
  setLock(doc, NODE_LOCKS_KEY, nodeId, locked)
}

/**
 * Edge ids the user has locked. A separate set from the node locks, not a
 * property derived from the endpoints: an edge is its own object here, so
 * locking one must not depend on what its endpoints happen to be.
 */
export function readEdgeLocks(doc: DocumentContainers): ReadonlySet<string> {
  return readLocks(doc, EDGE_LOCKS_KEY)
}

/** Edge counterpart to `setNodeLock` — same no-op-on-unchanged contract. */
export function setEdgeLock(doc: DocumentContainers, edgeId: string, locked: boolean): void {
  setLock(doc, EDGE_LOCKS_KEY, edgeId, locked)
}

export function readSpatialCanvas(doc: DocumentContainers): SpatialCanvas {
  return readSpatialCanvasWithSkipped(doc).canvas
}

/** Each stored record the schema accepts, and how many it refused. */
function readStored<T>(
  map: CanvasMap,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  lift: (raw: unknown) => unknown,
): { kept: T[]; skipped: number } {
  const kept: T[] = []
  let skipped = 0
  for (const id of map.keys()) {
    const parsed = schema.safeParse(lift(map.get(id)))
    if (parsed.success) kept.push(parsed.data)
    else skipped += 1
  }
  return { kept, skipped }
}

/**
 * `readSpatialCanvas`, plus how many stored nodes, edges and lines the schema
 * refused. Why a record fails validation is not knowable here (an older or
 * newer writer, or a bug in one), so this states only that it did; a caller
 * about to write the canvas back can then say it read less than the document
 * holds.
 */
export function readSpatialCanvasWithSkipped(doc: DocumentContainers): {
  readonly canvas: SpatialCanvas
  readonly skipped: number
} {
  const readNodes = readStored(doc.getMap(NODES_KEY), spatialNodeSchema, liftStoredNode)
  const readEdges = readStored(doc.getMap(EDGES_KEY), canvasEdgeSchema, liftLegacyExtension)
  const readLines = readStored(doc.getMap(LINES_KEY), canvasLineSchema, (raw) => raw)
  const { kept: nodes } = readNodes
  const { kept: edges } = readEdges
  const { kept: lines } = readLines

  const facets = readCanvasFacets(doc)
  const skipped =
    readNodes.skipped + readEdges.skipped + readLines.skipped + countUnreadableCanvasFacets(doc)
  const tags = readCanvasTags(doc)

  // The annotation layer is document-level and format-agnostic, so reading it
  // is not this reader's job — `readAnnotations` answers it for a markdown
  // document too. What stays here is only the lossy projection into the flat
  // shape the canvas renderer still takes.
  // With the nodes in hand: a passage of a node's text projects as a comment
  // on that node, which needs the node's corner to stand at.
  // The FIRST node with an id wins, as a scan from the front would answer: two
  // stored keys can hold one id only in a record a broken writer left.
  const nodeById = new Map<string, SpatialNode>()
  for (const node of nodes) if (!nodeById.has(node.id)) nodeById.set(node.id, node)
  const comments = readCanvasComments(doc, (id) => nodeById.get(id))

  const canvas: SpatialCanvas = {
    nodes,
    edges,
    // Omitted when empty, matching what the model canonicalises to — an
    // absent `lines` and an empty one say the same thing.
    ...(lines.length > 0 && { lines }),
    ...(facets !== undefined && { facets }),
    ...(tags !== undefined && { tags }),
    ...(comments.length > 0 && { comments }),
  }
  return { canvas, skipped }
}

/**
 * Writes exactly one comment's entry, leaving every other comment (and the
 * canvas envelope) untouched — the comment-level counterpart of
 * `writeSpatialNode`, and the write shape a "two peers comment concurrently"
 * merge depends on. Also the UPDATE path: resolving a comment is a rewrite
 * of the same id with `resolved: true`.
 */
export function writeCanvasComment(doc: DocumentContainers, comment: CanvasComment): void {
  writeCommentInto(doc, comment)
  doc.commit()
}

/**
 * Removes exactly one comment. Idempotent and a no-op (no commit) for an id
 * absent from the doc, matching `deleteSpatialEdge`.
 */
export function deleteCanvasComment(doc: DocumentContainers, commentId: string): void {
  if (deleteCommentInto(doc, commentId)) doc.commit()
}

/**
 * Every container this bridge reads or writes, by key and kind.
 *
 * Exists for hosts that place a document's containers somewhere attachment is
 * an OP — a workspace tree node's meta map, unlike a doc's roots, which are
 * implicit. Such a host must pre-attach these when the document node is
 * created: otherwise the first READ of a missing container attaches it via
 * `openMergeableMap`, and that stray local op clears the UndoManager's
 * redo stack. Measured: create → undo → read → redo left the document empty,
 * while the same sequence without the read redid fine.
 *
 * A container added to this bridge without an entry here reopens exactly that
 * bug for documents hosted on a tree node — extend the list with the key.
 */
export const CONTENT_CONTAINER_KEYS: ReadonlyArray<{ key: string; kind: 'map' | 'text' }> = [
  { key: NODES_KEY, kind: 'map' },
  { key: EDGES_KEY, kind: 'map' },
  { key: LINES_KEY, kind: 'map' },
  { key: CANVAS_KEY, kind: 'map' },
  { key: COMMENTS_KEY, kind: 'map' },
  { key: THREADS_KEY, kind: 'map' },
  { key: PROPOSALS_KEY, kind: 'map' },
  { key: FACETS_KEY, kind: 'map' },
  { key: NODE_LOCKS_KEY, kind: 'map' },
  { key: EDGE_LOCKS_KEY, kind: 'map' },
  { key: CORE_KEY, kind: 'map' },
  { key: TRUST_KEY, kind: 'map' },
  { key: DOCUMENT_KEY, kind: 'map' },
  { key: MARKDOWN_BODY_KEY, kind: 'text' },
]
