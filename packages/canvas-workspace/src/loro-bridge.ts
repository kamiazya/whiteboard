import {
  type CanvasCoreMeta,
  type CanvasEdge,
  canvasCoreMetaSchema,
  canvasEdgeSchema,
  canvasExtensionSchema,
  type ExtensionFacets,
  extensionFacetsSchema,
  type SpatialCanvas,
  type SpatialNode,
  spatialNodeSchema,
} from '@kamiazya/whiteboard-canvas-model'
import type { LoroDoc } from 'loro-crdt'
import type { z } from 'zod'

const NODES_KEY = 'nodes'
const EDGES_KEY = 'edges'
/**
 * The canvas ENVELOPE — properties of the canvas rather than of anything on
 * it (today: the `x-whiteboard` rendering preferences).
 *
 * A third top-level map rather than a field beside the node entries, because
 * the merge story is different in kind. Nodes and edges are keyed per object
 * so two peers editing different objects both survive; a canvas-wide
 * preference is ONE value with one meaning, and last-writer-wins per key is
 * the whole of what it needs.
 */
const CANVAS_KEY = 'canvas'
const EXTENSION_FIELD = 'x-whiteboard'
const FACETS_KEY = 'facets'
// Editor state that is NOT canvas content: stored beside the canvas in the
// same doc (so it survives reload and syncs to peers) but in its own map,
// which is what keeps it out of every export — `readSpatialCanvas` reads
// only NODES_KEY/EDGES_KEY, and every export path goes through it.
const NODE_LOCKS_KEY = 'nodeLocks'
const EDGE_LOCKS_KEY = 'edgeLocks'

/**
 * Drops a removed element's lock entry. Every node/edge removal path owes
 * this call — an entry left behind for an id the canvas no longer has would
 * be inherited by a later element reminted onto that id.
 */
function dropLockInto(doc: LoroDoc, mapKey: string, id: string): void {
  const locksMap = doc.getMap(mapKey)
  if (locksMap.keys().includes(id)) locksMap.delete(id)
}
const CORE_KEY = 'core'

type Fields = Record<string, unknown>

function nodeToFields(node: SpatialNode): Fields {
  const fields: Fields = {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  }
  if (node.color !== undefined) fields.color = node.color
  if (node['x-whiteboard'] !== undefined) fields['x-whiteboard'] = node['x-whiteboard']

  switch (node.type) {
    case 'text':
      fields.text = node.text
      break
    case 'file':
      fields.file = node.file
      if (node.subpath !== undefined) fields.subpath = node.subpath
      break
    case 'link':
      fields.url = node.url
      break
    case 'group':
      if (node.label !== undefined) fields.label = node.label
      if (node.background !== undefined) fields.background = node.background
      if (node.backgroundStyle !== undefined) fields.backgroundStyle = node.backgroundStyle
      break
  }
  return fields
}

function edgeToFields(edge: CanvasEdge): Fields {
  const fields: Fields = {
    id: edge.id,
    fromNode: edge.fromNode,
    toNode: edge.toNode,
  }
  if (edge.fromSide !== undefined) fields.fromSide = edge.fromSide
  if (edge.toSide !== undefined) fields.toSide = edge.toSide
  if (edge.fromEnd !== undefined) fields.fromEnd = edge.fromEnd
  if (edge.toEnd !== undefined) fields.toEnd = edge.toEnd
  if (edge.color !== undefined) fields.color = edge.color
  if (edge.label !== undefined) fields.label = edge.label
  return fields
}

export function writeSpatialCanvas(doc: LoroDoc, canvas: SpatialCanvas): void {
  const nodesMap = doc.getMap(NODES_KEY)
  const edgesMap = doc.getMap(EDGES_KEY)
  // Deleted rather than left behind when the canvas drops it: a canvas that
  // returned to the default must stop rendering a preference the author
  // turned off.
  const canvasMap = doc.getMap(CANVAS_KEY)
  const extension = canvas[EXTENSION_FIELD]
  if (extension === undefined) canvasMap.delete(EXTENSION_FIELD)
  else canvasMap.set(EXTENSION_FIELD, extension)

  const existingNodeIds = new Set<string>(nodesMap.keys())
  const existingEdgeIds = new Set<string>(edgesMap.keys())
  const incomingNodeIds = new Set<string>()
  const incomingEdgeIds = new Set<string>()

  for (const node of canvas.nodes) {
    incomingNodeIds.add(node.id)
    nodesMap.set(node.id, nodeToFields(node))
  }

  for (const edge of canvas.edges) {
    incomingEdgeIds.add(edge.id)
    edgesMap.set(edge.id, edgeToFields(edge))
  }

  // A resync is the second removal path, alongside deleteSpatialNode/Edge —
  // so it owes the same lock cascade.
  for (const id of existingNodeIds) {
    if (incomingNodeIds.has(id)) continue
    nodesMap.delete(id)
    dropLockInto(doc, NODE_LOCKS_KEY, id)
  }
  for (const id of existingEdgeIds) {
    if (incomingEdgeIds.has(id)) continue
    edgesMap.delete(id)
    dropLockInto(doc, EDGE_LOCKS_KEY, id)
  }

  doc.commit()
}

// Non-committing internals shared by the single committing helpers below
// and `withSpatialBatch`'s writer, so field projection and the delete
// cascade can never drift between the two paths.
function writeNodeInto(doc: LoroDoc, node: SpatialNode): void {
  doc.getMap(NODES_KEY).set(node.id, nodeToFields(node))
}

function writeEdgeInto(doc: LoroDoc, edge: CanvasEdge): void {
  doc.getMap(EDGES_KEY).set(edge.id, edgeToFields(edge))
}

/** Returns false (writing nothing) when the node id is absent. */
function deleteNodeCascadeInto(doc: LoroDoc, nodeId: string): boolean {
  const nodesMap = doc.getMap(NODES_KEY)
  const edgesMap = doc.getMap(EDGES_KEY)
  if (!nodesMap.keys().includes(nodeId)) return false

  nodesMap.delete(nodeId)
  dropLockInto(doc, NODE_LOCKS_KEY, nodeId)
  for (const edgeId of edgesMap.keys()) {
    const raw = edgesMap.get(edgeId)
    const parsed = canvasEdgeSchema.safeParse(raw)
    if (parsed.success && (parsed.data.fromNode === nodeId || parsed.data.toNode === nodeId)) {
      edgesMap.delete(edgeId)
      // The cascaded edges are removals too, so their own locks go with them.
      dropLockInto(doc, EDGE_LOCKS_KEY, edgeId)
    }
  }
  return true
}

/** Returns false (writing nothing) when the edge id is absent. */
function deleteEdgeInto(doc: LoroDoc, edgeId: string): boolean {
  const edgesMap = doc.getMap(EDGES_KEY)
  if (!edgesMap.keys().includes(edgeId)) return false
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
export function writeSpatialNode(doc: LoroDoc, node: SpatialNode): void {
  writeNodeInto(doc, node)
  doc.commit()
}

/**
 * Edge counterpart to `writeSpatialNode` — see its doc comment.
 */
export function writeSpatialEdge(doc: LoroDoc, edge: CanvasEdge): void {
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
export function deleteSpatialNode(doc: LoroDoc, nodeId: string): void {
  if (deleteNodeCascadeInto(doc, nodeId)) doc.commit()
}

/**
 * Edge counterpart to `deleteSpatialNode` — removes exactly one edge, no
 * cascade needed since an edge has no dependents of its own.
 */
export function deleteSpatialEdge(doc: LoroDoc, edgeId: string): void {
  if (deleteEdgeInto(doc, edgeId)) doc.commit()
}

/** Uncommitted spatial writes scoped to one `withSpatialBatch` call. */
export interface SpatialBatchWriter {
  writeNode(node: SpatialNode): void
  writeEdge(edge: CanvasEdge): void
  /** Same edge-cascade as `deleteSpatialNode`; absent ids write nothing. */
  deleteNode(nodeId: string): void
  deleteEdge(edgeId: string): void
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
 * converge with a committing write — canvas-sync-session's documented
 * fallback (`writeSpatialCanvas(doc, next)`) does exactly this, absorbing
 * the pending ops into one converged commit. Never follow a thrown batch
 * with an UNRELATED commit on the same doc: the pending ops would be
 * silently absorbed into that step.
 */
export function withSpatialBatch(doc: LoroDoc, fn: (writer: SpatialBatchWriter) => void): void {
  let wrote = false
  const writer: SpatialBatchWriter = {
    writeNode(node) {
      writeNodeInto(doc, node)
      wrote = true
    },
    writeEdge(edge) {
      writeEdgeInto(doc, edge)
      wrote = true
    },
    deleteNode(nodeId) {
      if (deleteNodeCascadeInto(doc, nodeId)) wrote = true
    },
    deleteEdge(edgeId) {
      if (deleteEdgeInto(doc, edgeId)) wrote = true
    },
  }
  fn(writer)
  // Success path only — a finally-commit would break the error contract
  // above (the session fallback's own commit must stay the only one).
  if (wrote) doc.commit()
}

function readLocks(doc: LoroDoc, mapKey: string): ReadonlySet<string> {
  const locksMap = doc.getMap(mapKey)
  const locked = new Set<string>()
  for (const id of locksMap.keys()) {
    if (locksMap.get(id) === true) locked.add(id)
  }
  return locked
}

function setLock(doc: LoroDoc, mapKey: string, id: string, locked: boolean): void {
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
export function readNodeLocks(doc: LoroDoc): ReadonlySet<string> {
  return readLocks(doc, NODE_LOCKS_KEY)
}

/**
 * Locks or unlocks one node. Writing the value a node already has is a
 * no-op (no commit, no undo step), matching this bridge's convention that
 * nothing-changed writes stay out of history.
 */
export function setNodeLock(doc: LoroDoc, nodeId: string, locked: boolean): void {
  setLock(doc, NODE_LOCKS_KEY, nodeId, locked)
}

/**
 * Edge ids the user has locked. A separate set from the node locks, not a
 * property derived from the endpoints: an edge is its own object here, so
 * locking one must not depend on what its endpoints happen to be.
 */
export function readEdgeLocks(doc: LoroDoc): ReadonlySet<string> {
  return readLocks(doc, EDGE_LOCKS_KEY)
}

/** Edge counterpart to `setNodeLock` — same no-op-on-unchanged contract. */
export function setEdgeLock(doc: LoroDoc, edgeId: string, locked: boolean): void {
  setLock(doc, EDGE_LOCKS_KEY, edgeId, locked)
}

export function readSpatialCanvas(doc: LoroDoc): SpatialCanvas {
  const nodesMap = doc.getMap(NODES_KEY)
  const edgesMap = doc.getMap(EDGES_KEY)

  const nodes: SpatialNode[] = []
  for (const nodeId of nodesMap.keys()) {
    const raw = nodesMap.get(nodeId)
    const parsed = spatialNodeSchema.safeParse(raw)
    if (parsed.success) nodes.push(parsed.data)
  }

  const edges: CanvasEdge[] = []
  for (const edgeId of edgesMap.keys()) {
    const raw = edgesMap.get(edgeId)
    const parsed = canvasEdgeSchema.safeParse(raw)
    if (parsed.success) edges.push(parsed.data)
  }

  // Parsed, not trusted: the stored value came from another version or peer,
  // and canvas-model's own rule for this key is that an unreadable payload
  // costs the preference, never the canvas.
  const extension = canvasExtensionSchema.safeParse(doc.getMap(CANVAS_KEY).get(EXTENSION_FIELD))
  return extension.success ? { nodes, edges, [EXTENSION_FIELD]: extension.data } : { nodes, edges }
}

/**
 * Replace a whole bucket map: write every incoming key and delete the keys
 * the caller omitted, so a rewrite never merges with stale prior state.
 * Entries stay per-key rather than one opaque object value, so two peers
 * writing different keys converge on both surviving after a CRDT merge.
 */
function replaceBucket(doc: LoroDoc, mapKey: string, entries: Fields): void {
  const map = doc.getMap(mapKey)
  const existingKeys = map.keys()

  for (const [key, value] of Object.entries(entries)) {
    map.set(key, value)
  }
  for (const key of existingKeys) {
    if (!Object.hasOwn(entries, key)) map.delete(key)
  }

  doc.commit()
}

/**
 * Extension facets (the `{domain}/{version}` keyed bucket from
 * canvas-model's `extensionFacetsSchema`) are stored the same way as
 * nodes/edges above: a plain-object-valued `LoroMap` keyed by facet key, so
 * one domain's CRDT merge never overwrites another's.
 */
export function writeFacets(doc: LoroDoc, facets: ExtensionFacets): void {
  replaceBucket(doc, FACETS_KEY, facets)
}

/**
 * A per-key parse (rather than one whole-record parse) means a single
 * corrupt entry in the underlying LoroMap is dropped instead of failing the
 * entire read — consistent with readSpatialCanvas's per-node tolerance.
 */
export function readFacets(doc: LoroDoc): ExtensionFacets {
  const facetsMap = doc.getMap(FACETS_KEY)
  const result: ExtensionFacets = {}
  for (const key of facetsMap.keys()) {
    const value = facetsMap.get(key)
    const parsed = extensionFacetsSchema.safeParse({ [key]: value })
    if (parsed.success) result[key] = parsed.data[key]
  }
  return result
}

const CORE_FACET_FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = canvasCoreMetaSchema.shape

/**
 * Core OKF facets (`type`/`title`/`tags`/`view`/`facetsRaw`) are stored the
 * same way as extension facets above: one `LoroMap` keyed per field, not one
 * opaque object value, so two peers writing different core fields converge
 * on both surviving after a merge. `type` is the only required field; a
 * write always replaces the whole document meta (deletes fields the caller
 * omitted) rather than merging with stale prior state, matching
 * `writeFacets`'s replace-on-rewrite convention.
 */
export function writeCoreFacets(doc: LoroDoc, meta: CanvasCoreMeta): void {
  replaceBucket(doc, CORE_KEY, { ...meta })
}

/**
 * An empty `core` map (never written, or every field deleted) means no
 * core meta is stored — `undefined`, distinct from an all-optional-fields
 * empty object which is unrepresentable anyway (`type` is required). A
 * single corrupt field is dropped rather than failing the whole read, but
 * a missing/invalid `type` after that per-field filter makes the whole
 * result unrepresentable, since `type` is the one field every consumer
 * (`canvas_export_okf`'s placeholder fallback) depends on being present.
 */
export function readCoreFacets(doc: LoroDoc): CanvasCoreMeta | undefined {
  const coreMap = doc.getMap(CORE_KEY)
  if (coreMap.keys().length === 0) return undefined

  const candidate: Record<string, unknown> = {}
  for (const key of coreMap.keys()) {
    const fieldSchema = CORE_FACET_FIELD_SCHEMAS[key]
    if (!fieldSchema) continue
    const parsed = fieldSchema.safeParse(coreMap.get(key))
    if (parsed.success) candidate[key] = parsed.data
  }

  const result = canvasCoreMetaSchema.safeParse(candidate)
  return result.success ? result.data : undefined
}
