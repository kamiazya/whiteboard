import type { LoroDoc } from 'loro-crdt'
import {
  spatialNodeSchema,
  canvasEdgeSchema,
  extensionFacetsSchema,
  type SpatialCanvas,
  type SpatialNode,
  type CanvasEdge,
  type ExtensionFacets,
} from '@kamiazya/whiteboard-canvas-model'

const NODES_KEY = 'nodes'
const EDGES_KEY = 'edges'
const FACETS_KEY = 'facets'

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
 * Extension facets (the `{domain}/{version}` keyed bucket from
 * canvas-model's `extensionFacetsSchema`) are stored the same way as
 * nodes/edges above: a plain-object-valued `LoroMap` keyed by facet key, so
 * one domain's CRDT merge never overwrites another's.
 */
export function writeFacets(doc: LoroDoc, facets: ExtensionFacets): void {
  const facetsMap = doc.getMap(FACETS_KEY)
  const existingKeys = new Set<string>(facetsMap.keys())
  const incomingKeys = new Set<string>(Object.keys(facets))

  for (const [key, value] of Object.entries(facets)) {
    facetsMap.set(key, value)
  }
  for (const key of existingKeys) {
    if (!incomingKeys.has(key)) facetsMap.delete(key)
  }

  doc.commit()
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
