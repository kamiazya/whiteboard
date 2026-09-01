import {
  type CanvasComment,
  type CanvasEdge,
  canvasCommentSchema,
  canvasEdgeSchema,
  canvasExtensionSchema,
  type DocumentKind,
  documentKindSchema,
  type ExtensionFacets,
  extensionFacetsSchema,
  type SpatialCanvas,
  type SpatialNode,
  type StoredCoreFacets,
  spatialNodeSchema,
  storedCoreFacetsSchema,
  type TrustFacets,
  trustFacetsSchema,
} from '@kamiazya/whiteboard-model'
import type { LoroMap, LoroText } from 'loro-crdt'
import type { z } from 'zod'

/**
 * Where one document's containers live.
 *
 * Every function below reaches for containers by name and never for the
 * document as a whole, so the only thing it needs is something that can hand
 * one over. `LoroDoc` satisfies this structurally — a document's containers
 * are its roots — and so does a workspace-tree node, whose containers hang off
 * its own meta map. That is the whole reason this type exists: the two storage
 * models differ in WHERE a container is found and in nothing else, so the
 * bridge should not have to be written twice.
 *
 * Call sites that pass a `LoroDoc` keep compiling unchanged.
 */
export interface DocumentContainers {
  getMap(key: string): LoroMap
  getText(key: string): LoroText
  /**
   * Part of the seam because the bridge decides where a write ENDS, and that
   * is not something to leave each caller to remember. A tree-node host
   * delegates to the document its node belongs to.
   */
  commit(): void
}

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
/**
 * The comment annotation layer (ADR-0024), keyed per comment like nodes and
 * edges — NOT stored inside the canvas envelope above, although the model
 * type carries comments on `x-whiteboard`. The envelope is whole-value LWW,
 * which is right for a preference and exactly wrong for comments: two peers
 * commenting concurrently must both survive a merge. `writeSpatialCanvas`
 * splits the field out on write and `readSpatialCanvas` reassembles it.
 */
const COMMENTS_KEY = 'comments'
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
function dropLockInto(doc: DocumentContainers, mapKey: string, id: string): void {
  const locksMap = doc.getMap(mapKey)
  if (locksMap.keys().includes(id)) locksMap.delete(id)
}
const CORE_KEY = 'core'
/**
 * OKF v0.2's trust family gets a bucket of its own rather than joining
 * `core`, because `writeCoreFacets` replaces the whole core bucket and
 * deletes anything the caller omitted — a server-written stamp living there
 * would be erased by any client that rewrote its own tags (ADR-0016).
 */
const TRUST_KEY = 'trust'

/**
 * Document-level envelope: what the document IS, above any one format's
 * structure. Kept out of `core` because that map is OKF frontmatter, which
 * a JSON Canvas document has no business carrying (ADR-0009 decision 3).
 */
const DOCUMENT_KEY = 'document'

type Fields = Record<string, unknown>

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

function commentToFields(comment: CanvasComment): Fields {
  // Same loud refusal as nodeToFields: readSpatialCanvas round-trips every
  // comment through the Zod schema and silently drops failures, so a NaN
  // anchor written here would delete the comment for every reader.
  for (const [field, value] of [
    ['x', comment.x],
    ['y', comment.y],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `canvas comment "${comment.id}" has a non-finite ${field} (${value}); the anchor must be finite`,
      )
    }
  }
  const fields: Fields = { id: comment.id, x: comment.x, y: comment.y, text: comment.text }
  if (comment.author !== undefined) fields.author = comment.author
  if (comment.createdAt !== undefined) fields.createdAt = comment.createdAt
  if (comment.targetNodeId !== undefined) fields.targetNodeId = comment.targetNodeId
  if (comment.resolved !== undefined) fields.resolved = comment.resolved
  return fields
}

export function writeSpatialCanvas(doc: DocumentContainers, canvas: SpatialCanvas): void {
  const nodesMap = doc.getMap(NODES_KEY)
  const edgesMap = doc.getMap(EDGES_KEY)
  // Deleted rather than left behind when the canvas drops it: a canvas that
  // returned to the default must stop rendering a preference the author
  // turned off. Comments are split OUT of the envelope value first — see
  // COMMENTS_KEY for why they must not ride the whole-value LWW write.
  const canvasMap = doc.getMap(CANVAS_KEY)
  const { comments, ...envelope } = canvas[EXTENSION_FIELD] ?? {}
  if (Object.values(envelope).every((value) => value === undefined)) {
    canvasMap.delete(EXTENSION_FIELD)
  } else {
    canvasMap.set(EXTENSION_FIELD, envelope)
  }

  const commentsMap = doc.getMap(COMMENTS_KEY)
  const existingCommentIds = new Set<string>(commentsMap.keys())
  for (const comment of comments ?? []) {
    existingCommentIds.delete(comment.id)
    commentsMap.set(comment.id, commentToFields(comment))
  }
  // A resync states the whole truth, comments included.
  for (const id of existingCommentIds) commentsMap.delete(id)

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
function writeNodeInto(doc: DocumentContainers, node: SpatialNode): void {
  doc.getMap(NODES_KEY).set(node.id, nodeToFields(node))
}

function writeEdgeInto(doc: DocumentContainers, edge: CanvasEdge): void {
  doc.getMap(EDGES_KEY).set(edge.id, edgeToFields(edge))
}

/** Returns false (writing nothing) when the node id is absent. */
function deleteNodeCascadeInto(doc: DocumentContainers, nodeId: string): boolean {
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
function deleteEdgeInto(doc: DocumentContainers, edgeId: string): boolean {
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
  if (deleteNodeCascadeInto(doc, nodeId)) doc.commit()
}

/**
 * Edge counterpart to `deleteSpatialNode` — removes exactly one edge, no
 * cascade needed since an edge has no dependents of its own.
 */
export function deleteSpatialEdge(doc: DocumentContainers, edgeId: string): void {
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
  // and model's own rule for this key is that an unreadable payload
  // costs the preference, never the canvas. Any `comments` a buggy writer
  // left INSIDE the envelope are discarded here — the comments map below is
  // the single source of that field.
  const parsedEnvelope = canvasExtensionSchema.safeParse(
    doc.getMap(CANVAS_KEY).get(EXTENSION_FIELD),
  )
  const { comments: _strayComments, ...envelope } = parsedEnvelope.success
    ? parsedEnvelope.data
    : {}

  const commentsMap = doc.getMap(COMMENTS_KEY)
  const comments: CanvasComment[] = []
  for (const commentId of commentsMap.keys()) {
    const parsed = canvasCommentSchema.safeParse(commentsMap.get(commentId))
    if (parsed.success) comments.push(parsed.data)
  }

  const hasEnvelope = Object.values(envelope).some((value) => value !== undefined)
  if (!hasEnvelope && comments.length === 0) return { nodes, edges }
  return {
    nodes,
    edges,
    [EXTENSION_FIELD]: comments.length > 0 ? { ...envelope, comments } : envelope,
  }
}

/**
 * Writes exactly one comment's entry, leaving every other comment (and the
 * canvas envelope) untouched — the comment-level counterpart of
 * `writeSpatialNode`, and the write shape a "two peers comment concurrently"
 * merge depends on. Also the UPDATE path: resolving a comment is a rewrite
 * of the same id with `resolved: true`.
 */
export function writeCanvasComment(doc: DocumentContainers, comment: CanvasComment): void {
  doc.getMap(COMMENTS_KEY).set(comment.id, commentToFields(comment))
  doc.commit()
}

/**
 * Removes exactly one comment. Idempotent and a no-op (no commit) for an id
 * absent from the doc, matching `deleteSpatialEdge`.
 */
export function deleteCanvasComment(doc: DocumentContainers, commentId: string): void {
  const commentsMap = doc.getMap(COMMENTS_KEY)
  if (!commentsMap.keys().includes(commentId)) return
  commentsMap.delete(commentId)
  doc.commit()
}

/**
 * Replace a whole bucket map: write every incoming key and delete the keys
 * the caller omitted, so a rewrite never merges with stale prior state.
 * Entries stay per-key rather than one opaque object value, so two peers
 * writing different keys converge on both surviving after a CRDT merge.
 */
function replaceBucket(doc: DocumentContainers, mapKey: string, entries: Fields): void {
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
 * Extension facets (the `{namespace}.{name}/v{n}` keyed bucket from
 * model's `extensionFacetsSchema`) are stored the same way as
 * nodes/edges above: a plain-object-valued `LoroMap` keyed by facet key, so
 * one domain's CRDT merge never overwrites another's.
 */
export function writeFacets(doc: DocumentContainers, facets: ExtensionFacets): void {
  replaceBucket(doc, FACETS_KEY, facets)
}

/**
 * A per-key parse (rather than one whole-record parse) means a single
 * corrupt entry in the underlying LoroMap is dropped instead of failing the
 * entire read — consistent with readSpatialCanvas's per-node tolerance.
 */
export function readFacets(doc: DocumentContainers): ExtensionFacets {
  const facetsMap = doc.getMap(FACETS_KEY)
  const result: ExtensionFacets = {}
  for (const key of facetsMap.keys()) {
    const value = facetsMap.get(key)
    const parsed = extensionFacetsSchema.safeParse({ [key]: value })
    if (parsed.success) result[key] = parsed.data[key]
  }
  return result
}

/**
 * Prototype-less on purpose. The keys looked up here come from a LoroMap,
 * whose keys are CRDT strings arriving over sync or import — so `__proto__`
 * is a possible key, and on a plain object it would resolve up the chain to
 * `Object.prototype`: truthy, past any `if (!schema)` guard, and without a
 * `safeParse` to call. A null prototype makes every miss a real miss.
 */
const CORE_FACET_FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = Object.assign(
  Object.create(null),
  storedCoreFacetsSchema.shape,
)

/**
 * Core OKF facets (`type`/`title`/`tags`/`view`/`facetsRaw`) are stored the
 * same way as extension facets above: one `LoroMap` keyed per field, not one
 * opaque object value, so two peers writing different core fields converge
 * on both surviving after a merge. `type` is the only required field; a
 * write always replaces the whole document meta (deletes fields the caller
 * omitted) rather than merging with stale prior state, matching
 * `writeFacets`'s replace-on-rewrite convention.
 */
export function writeCoreFacets(doc: DocumentContainers, meta: StoredCoreFacets): void {
  replaceBucket(doc, CORE_KEY, { ...meta })
}

/** Prototype-less for the same reason `CORE_FACET_FIELD_SCHEMAS` is. */
const TRUST_FACET_FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = Object.assign(
  Object.create(null),
  trustFacetsSchema.shape,
)

/**
 * The OKF v0.2 trust family (§5.2), stored per-key like every other bucket
 * here so two peers writing `generated` and `verified` converge on both.
 * Replace-on-rewrite, matching `writeCoreFacets`/`writeFacets`: a write
 * states the whole family rather than merging with whatever was there.
 */
export function writeTrustFacets(doc: DocumentContainers, trust: TrustFacets): void {
  const entries: Fields = {}
  if (trust.generated !== undefined) entries.generated = { ...trust.generated }
  if (trust.verified !== undefined) entries.verified = trust.verified.map((event) => ({ ...event }))
  replaceBucket(doc, TRUST_KEY, entries)
}

/**
 * A SPATIAL document answers `undefined` whatever its `trust` map holds, for
 * the same reason `readCoreFacets` does: the trust family are OKF root
 * frontmatter keys, and a JSON Canvas document has no frontmatter to project
 * them into (ADR-0016 decision 5).
 *
 * A corrupt field is dropped rather than failing the whole read, matching
 * `readCoreFacets`. Unlike it, there is no required field here — a document
 * with a `verified` list and no `generated` is a perfectly good OKF concept —
 * so an all-dropped read answers `undefined` rather than an empty object.
 */
export function readTrustFacets(doc: DocumentContainers): TrustFacets | undefined {
  if (readDocumentKind(doc) === 'spatial') return undefined

  const trustMap = doc.getMap(TRUST_KEY)
  if (trustMap.keys().length === 0) return undefined

  const candidate: Record<string, unknown> = {}
  for (const key of trustMap.keys()) {
    const fieldSchema = TRUST_FACET_FIELD_SCHEMAS[key]
    if (!fieldSchema) continue
    const parsed = fieldSchema.safeParse(trustMap.get(key))
    if (parsed.success) candidate[key] = parsed.data
  }
  if (Object.keys(candidate).length === 0) return undefined
  return trustFacetsSchema.parse(candidate)
}

/**
 * An empty `core` map (never written, or every field deleted) means no
 * core meta is stored — `undefined`, distinct from an all-optional-fields
 * empty object which is unrepresentable anyway (`type` is required). A
 * single corrupt field is dropped rather than failing the whole read, but
 * a missing/invalid `type` after that per-field filter makes the whole
 * result unrepresentable, since `type` is the one field every consumer
 * (`canvas_export_okf`'s placeholder fallback) depends on being present.
 *
 * A SPATIAL document answers `undefined` whatever its `core` map holds. A
 * facet is OKF frontmatter and a JSON Canvas document has none to put one in
 * (ADR-0009 decision 3), so a spatial document carrying facets is one written
 * before that stopped being true — and every reader that surfaces them
 * (a facet card beside a diagram, an OKF export's frontmatter) is showing
 * metadata the format cannot represent. Enforced on the READ because it is
 * total: it needs no migration, and no writer can reintroduce the state
 * behind it — `wb_facet_set` and `wb_document_set` both refuse a spatial
 * document, and after this there is no other writer.
 *
 * A document with no kind is allowed through, exactly as those tools allow
 * one: an absent kind is not evidence of a format.
 */
export function readCoreFacets(doc: DocumentContainers): StoredCoreFacets | undefined {
  if (readDocumentKind(doc) === 'spatial') return undefined

  const coreMap = doc.getMap(CORE_KEY)
  if (coreMap.keys().length === 0) return undefined

  const candidate: Record<string, unknown> = {}
  for (const key of coreMap.keys()) {
    const fieldSchema = CORE_FACET_FIELD_SCHEMAS[key]
    if (!fieldSchema) continue
    const parsed = fieldSchema.safeParse(coreMap.get(key))
    if (parsed.success) candidate[key] = parsed.data
  }

  const result = storedCoreFacetsSchema.safeParse(candidate)
  return result.success ? result.data : undefined
}

/**
 * The Loro text container a markdown document's body lives in, and the one
 * apps/web's browser-local editor binds its CRDT editing session to.
 *
 * Exported because that binding needs the container HANDLE, not its text —
 * `readMarkdownBody` cannot serve it, and a second `'body'` literal on the
 * apps/web side would be a contract duplicated across a package boundary.
 */
export const MARKDOWN_BODY_KEY = 'body'

/**
 * The stored id of the single text node a markdown document's body USED to
 * live in on the daemon side. Nothing writes it any more — `wb_document_set`
 * writes the text container — but stored documents still hold one, so it is
 * how a reader finds such a body and how that tool recognises a document it
 * could itself have written.
 */
export const MARKDOWN_BODY_NODE_ID = 'okf-body'

/**
 * A markdown document's body, whichever way this codebase stored it.
 *
 * Every writer now writes the Loro TEXT CONTAINER named `body`
 * (`writeMarkdownBody`). It did not start that way: `wb_document_set` used
 * to store the body as a single `okf-body` TEXT NODE inside the spatial
 * canvas — which is why a markdown document also parsed as a perfectly
 * valid, if odd, canvas — while apps/web's editor wrote the container so a
 * CRDT editing session had something to bind to. Neither side could read
 * the other's documents until this function existed, and stored documents
 * still hold the old shape, so it keeps reading both.
 *
 * The container wins when both are present: writers supersede the node
 * rather than removing it in a migration, so where both exist the container
 * is the newer one.
 *
 * Falls back to the FIRST text node rather than requiring the id, because
 * documents written before the id was stable still have to be readable. An
 * empty string for a document with no body at all is the honest answer: it
 * has no body, which is a valid state, not a failure.
 */
export function readMarkdownBody(doc: DocumentContainers): string {
  const container = doc.getText(MARKDOWN_BODY_KEY).toString()
  if (container.length > 0) return container

  return markdownBodyFromCanvas(readSpatialCanvas(doc))
}

type SpatialTextNode = Extract<SpatialNode, { type: 'text' }>

/**
 * The node a markdown document's body lives in, given an already-read
 * canvas: the stable id first, then the first text node (pre-stable-id
 * documents), matching `readMarkdownBody`'s node-side selection exactly.
 */
function findMarkdownBodyNode(nodes: SpatialCanvas['nodes']): SpatialTextNode | undefined {
  const byId = nodes.find((node) => node.id === MARKDOWN_BODY_NODE_ID)
  if (byId?.type === 'text') return byId
  return nodes.find((node): node is SpatialTextNode => node.type === 'text')
}

/**
 * The node-side half of `readMarkdownBody`. Private on purpose: it is a
 * legacy READ fallback for documents an older writer left, and exporting it
 * is what let a caller treat the node as a live representation to write.
 */
function markdownBodyFromCanvas(canvas: SpatialCanvas): string {
  return findMarkdownBodyNode(canvas.nodes)?.text ?? ''
}

/**
 * Replaces a markdown document's body, and makes the document stop being a
 * spatial canvas at the same time.
 *
 * The CONTAINER is the representation, not a text node inside the spatial
 * canvas. Two reasons, and the second is the one that keeps biting:
 *
 * - It is the CRDT-native form. apps/web binds a collaborative editing
 *   session straight to it (`LoroSyncPlugin`), which a plain string field
 *   on a node cannot support — character-level merge is the whole point.
 * - Storing a body as a text NODE made a markdown document parse as a
 *   perfectly valid spatial canvas holding one node. That is why anything
 *   resolving a reference has to ask the document its kind before it can
 *   tell prose from a diagram: "does it parse as a canvas" answers yes for
 *   both. Writing the container and emptying the canvas removes the
 *   ambiguity at the source rather than guarding against it downstream.
 *
 * Clearing the canvas also supersedes a legacy `okf-body` node left by the
 * older writer, so a rewritten document cannot keep a stale second body for
 * a later reader to find.
 */
export function writeMarkdownBody(doc: DocumentContainers, body: string): void {
  const text = doc.getText(MARKDOWN_BODY_KEY)
  text.delete(0, text.length)
  if (body.length > 0) text.insert(0, body)
  // Only when there is something to clear. This runs on every keystroke in
  // the browser editor, where the canvas is already empty and an
  // unconditional rewrite would add CRDT operations — and a save — for a
  // change nobody made.
  if (doc.getMap(NODES_KEY).size > 0 || doc.getMap(EDGES_KEY).size > 0) {
    writeSpatialCanvas(doc, { nodes: [], edges: [] })
  }
  doc.commit()
}

/**
 * The kind a document was created as. `wb_document_get` serialises through
 * it — a spatial document as JSON Canvas, a markdown one as OKF — so this
 * is what makes a format follow from the document rather than from a
 * caller-supplied parameter (ADR-0009 decision 4).
 */
export function writeDocumentKind(doc: DocumentContainers, kind: DocumentKind): void {
  doc.getMap(DOCUMENT_KEY).set('kind', kind)
  doc.commit()
}

/**
 * `undefined` for a document written before kinds existed, and for a kind
 * this build does not recognise — a peer on a newer version can write one
 * into the same CRDT map. Both cases are for the caller to report; failing
 * here would replace its message with a parse error from three layers down.
 */
export function readDocumentKind(doc: DocumentContainers): DocumentKind | undefined {
  const parsed = documentKindSchema.safeParse(doc.getMap(DOCUMENT_KEY).get('kind'))
  return parsed.success ? parsed.data : undefined
}

/**
 * Every container this bridge reads or writes, by key and kind.
 *
 * Exists for hosts that place a document's containers somewhere attachment is
 * an OP — a workspace tree node's meta map, unlike a doc's roots, which are
 * implicit. Such a host must pre-attach these when the document node is
 * created: otherwise the first READ of a missing container attaches it via
 * `getOrCreateContainer`, and that stray local op clears the UndoManager's
 * redo stack. Measured: create → undo → read → redo left the document empty,
 * while the same sequence without the read redid fine.
 *
 * A container added to this bridge without an entry here reopens exactly that
 * bug for documents hosted on a tree node — extend the list with the key.
 */
export const CONTENT_CONTAINER_KEYS: ReadonlyArray<{ key: string; kind: 'map' | 'text' }> = [
  { key: NODES_KEY, kind: 'map' },
  { key: EDGES_KEY, kind: 'map' },
  { key: CANVAS_KEY, kind: 'map' },
  { key: COMMENTS_KEY, kind: 'map' },
  { key: FACETS_KEY, kind: 'map' },
  { key: NODE_LOCKS_KEY, kind: 'map' },
  { key: EDGE_LOCKS_KEY, kind: 'map' },
  { key: CORE_KEY, kind: 'map' },
  { key: TRUST_KEY, kind: 'map' },
  { key: DOCUMENT_KEY, kind: 'map' },
  { key: MARKDOWN_BODY_KEY, kind: 'text' },
]
