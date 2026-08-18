import { readEdgeLocks, readNodeLocks } from '@kamiazya/whiteboard-loro-adapter'
import {
  type CanvasEdge,
  canvasColorSchema,
  documentIdSchema,
  nodeIdSchema,
  type SpatialCanvas,
  type SpatialNode,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { assertSpatialDocument, loadSpatialCanvas } from '../render/load-spatial-canvas.js'
import type { ServerDeps } from '../server-deps.js'

/**
 * Per-node text budget, in characters. A text node can hold a whole markdown
 * document, so without this one node can consume an agent's entire context.
 */
export const SNAPSHOT_TEXT_MAX_CHARS = 400
/** Upper bound on the nodes returned. Boards larger than this are reported truncated. */
export const SNAPSHOT_MAX_NODES = 300
/** Upper bound on the edges returned, budgeted independently of nodes. */
export const SNAPSHOT_MAX_EDGES = 600

/**
 * `locked` and `textTruncated` are `z.literal(true).optional()` rather than
 * plain booleans: this payload is sized for an agent's context window, and
 * emitting `false` on every node of a 300-node board costs more than the
 * information is worth. Absent means "no".
 */
const canvasSnapshotNodeSchema = z
  .object({
    id: nodeIdSchema,
    type: z.enum(['text', 'file', 'link', 'group']),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
    /** text nodes only, cut to SNAPSHOT_TEXT_MAX_CHARS. */
    text: z.string().optional(),
    textTruncated: z.literal(true).optional(),
    /** group nodes only. */
    label: z.string().optional(),
    /** file nodes only. */
    file: z.string().optional(),
    /** link nodes only. */
    url: z.string().optional(),
    color: canvasColorSchema.optional(),
    locked: z.literal(true).optional(),
  })
  .strict()

const canvasSnapshotEdgeSchema = z
  .object({
    id: nodeIdSchema,
    fromNode: nodeIdSchema,
    toNode: nodeIdSchema,
    label: z.string().optional(),
    color: canvasColorSchema.optional(),
    locked: z.literal(true).optional(),
  })
  .strict()

export const canvasSnapshotSchema = z
  .object({
    documentId: documentIdSchema,
    nodes: z.array(canvasSnapshotNodeSchema),
    edges: z.array(canvasSnapshotEdgeSchema),
    /**
     * The REAL totals on the board, not the returned lengths. A cap that
     * hides how much it dropped is worse than no cap: an agent reading a
     * capped list with no signal believes it has seen the whole board.
     */
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict()
export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>

const canvasSnapshotInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema })
  .strict()
type CanvasSnapshotInput = z.infer<typeof canvasSnapshotInputSchema>

function projectNode(
  node: SpatialNode,
  locked: boolean,
): { node: z.infer<typeof canvasSnapshotNodeSchema>; truncated: boolean } {
  const base = {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...(node.color === undefined ? {} : { color: node.color }),
    ...(locked ? { locked: true as const } : {}),
  }

  switch (node.type) {
    case 'text': {
      const cut = node.text.length > SNAPSHOT_TEXT_MAX_CHARS
      return {
        // No ellipsis is appended on a cut: the value stays an exact prefix
        // of the stored text, so an agent can match it against what it wrote.
        node: {
          ...base,
          text: cut ? node.text.slice(0, SNAPSHOT_TEXT_MAX_CHARS) : node.text,
          ...(cut ? { textTruncated: true as const } : {}),
        },
        truncated: cut,
      }
    }
    case 'group':
      return {
        node: { ...base, ...(node.label === undefined ? {} : { label: node.label }) },
        truncated: false,
      }
    case 'file':
      return { node: { ...base, file: node.file }, truncated: false }
    case 'link':
      return { node: { ...base, url: node.url }, truncated: false }
  }
}

function projectEdge(edge: CanvasEdge, locked: boolean): z.infer<typeof canvasSnapshotEdgeSchema> {
  return {
    id: edge.id,
    fromNode: edge.fromNode,
    toNode: edge.toNode,
    ...(edge.label === undefined ? {} : { label: edge.label }),
    ...(edge.color === undefined ? {} : { color: edge.color }),
    ...(locked ? { locked: true as const } : {}),
  }
}

/**
 * Projects a canvas value plus its lock sets into the snapshot payload.
 *
 * Split out from the tool so `wb_canvas_edit` can answer with the board it
 * just produced without a second load — the two must agree field for field,
 * and the only way to guarantee that is one projection.
 */
export function projectCanvasSnapshot(
  documentId: string,
  canvas: SpatialCanvas,
  nodeLocks: ReadonlySet<string>,
  edgeLocks: ReadonlySet<string>,
): CanvasSnapshot {
  const projected = canvas.nodes
    .slice(0, SNAPSHOT_MAX_NODES)
    .map((node) => projectNode(node, nodeLocks.has(node.id)))
  const edges = canvas.edges
    .slice(0, SNAPSHOT_MAX_EDGES)
    .map((edge) => projectEdge(edge, edgeLocks.has(edge.id)))

  return {
    documentId,
    nodes: projected.map((entry) => entry.node),
    edges,
    nodeCount: canvas.nodes.length,
    edgeCount: canvas.edges.length,
    truncated:
      canvas.nodes.length > SNAPSHOT_MAX_NODES ||
      canvas.edges.length > SNAPSHOT_MAX_EDGES ||
      projected.some((entry) => entry.truncated),
  }
}

/**
 * The compact, semantic read of a spatial canvas — what an agent should
 * reach for before editing one.
 *
 * It is deliberately NOT `wb_scene_digest`, which reports laid-out geometry
 * (overlaps, clusters, free regions) and carries no text, edges or node
 * types at all. The two answer different questions and neither subsumes the
 * other: digest says whether a board is tidy, this says what is on it.
 *
 * It is also not `wb_document_get`, which returns the untruncated JSON
 * Canvas: on a large board or a node holding a whole markdown document that
 * payload is unbounded, and being safe to call on any board is the whole
 * reason this tool exists.
 *
 * Both caps take the FIRST N in stored order.
 * ponytail: stored order, viewport- or selection-scoped windowing if
 * reading past the cap turns out to matter.
 */
export function createCanvasSnapshotTool(deps: ServerDeps) {
  return {
    name: 'wb_canvas_snapshot' as const,
    description:
      'Read a spatial canvas as a compact snapshot: every node with its type, text, geometry and lock state, plus every edge. Long text and large boards are cut, and the true totals are reported alongside so nothing is hidden silently. Prefer this over wb_document_get when reading a canvas to decide what to change.',
    inputSchema: canvasSnapshotInputSchema,
    outputSchema: canvasSnapshotSchema,
    async execute(input: CanvasSnapshotInput): Promise<CanvasSnapshot> {
      const { doc, canvas } = await loadSpatialCanvas(deps, input.documentId)
      await assertSpatialDocument(
        deps,
        input.workspaceId,
        input.documentId,
        doc,
        'wb_canvas_snapshot',
      )

      return projectCanvasSnapshot(input.documentId, canvas, readNodeLocks(doc), readEdgeLocks(doc))
    },
  }
}
