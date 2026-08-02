import {
  type CanvasCoreMeta,
  type CanvasEdge,
  canvasCoreMetaSchema,
  canvasEdgeSchema,
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
const FACETS_KEY = 'facets'
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

  for (const id of existingNodeIds) {
    if (!incomingNodeIds.has(id)) nodesMap.delete(id)
  }
  for (const id of existingEdgeIds) {
    if (!incomingEdgeIds.has(id)) edgesMap.delete(id)
  }

  doc.commit()
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
  doc.getMap(NODES_KEY).set(node.id, nodeToFields(node))
  doc.commit()
}

/**
 * Edge counterpart to `writeSpatialNode` — see its doc comment.
 */
export function writeSpatialEdge(doc: LoroDoc, edge: CanvasEdge): void {
  doc.getMap(EDGES_KEY).set(edge.id, edgeToFields(edge))
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
  const nodesMap = doc.getMap(NODES_KEY)
  const edgesMap = doc.getMap(EDGES_KEY)
  if (!nodesMap.keys().includes(nodeId)) return

  nodesMap.delete(nodeId)
  for (const edgeId of edgesMap.keys()) {
    const raw = edgesMap.get(edgeId)
    const parsed = canvasEdgeSchema.safeParse(raw)
    if (parsed.success && (parsed.data.fromNode === nodeId || parsed.data.toNode === nodeId)) {
      edgesMap.delete(edgeId)
    }
  }
  doc.commit()
}

/**
 * Edge counterpart to `deleteSpatialNode` — removes exactly one edge, no
 * cascade needed since an edge has no dependents of its own.
 */
export function deleteSpatialEdge(doc: LoroDoc, edgeId: string): void {
  const edgesMap = doc.getMap(EDGES_KEY)
  if (!edgesMap.keys().includes(edgeId)) return
  edgesMap.delete(edgeId)
  doc.commit()
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

  return { nodes, edges }
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
