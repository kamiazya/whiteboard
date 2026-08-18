import { tidyNodes } from '@kamiazya/whiteboard-canvas-render'
import {
  readDocumentKind,
  readEdgeLocks,
  readNodeLocks,
  setEdgeLock,
  setNodeLock,
  writeDocumentKind,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  type CanvasEdge,
  canvasColorSchema,
  canvasEdgeSchema,
  documentIdSchema,
  nodeIdSchema,
  type SpatialCanvas,
  type SpatialNode,
  spatialCanvasSchema,
  spatialNodeSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { canvasSnapshotSchema, projectCanvasSnapshot } from './canvas-snapshot.js'
import { loadDocument, saveDocumentBodySnapshot } from './document-io.js'
import { DocumentKindMismatchError } from './errors.js'

/** How many auto-placed nodes go in a row before the next one wraps. */
export const PLACEMENT_COLUMNS = 4
/** Gap left between auto-placed nodes, and between them and existing content. */
export const PLACEMENT_GUTTER_PX = 40

/**
 * Size given to a node that names none. A model asked to invent four
 * integers per node spends its attention on arithmetic instead of on the
 * diagram, so every geometry field is optional and these fill the gap.
 */
const DEFAULT_SIZE: Record<SpatialNode['type'], { width: number; height: number }> = {
  text: { width: 260, height: 120 },
  file: { width: 260, height: 120 },
  link: { width: 260, height: 120 },
  group: { width: 400, height: 300 },
}

/**
 * Thrown when one op in a batch cannot apply. Nothing is written — the
 * whole batch is refused.
 *
 * `opIndex` is in the MESSAGE as well as on the class because only
 * `.message` survives the MCP error path, and a model repairing a rejected
 * batch needs to know WHICH op it got wrong.
 */
class CanvasEditError extends Error {
  constructor(
    readonly opIndex: number,
    readonly op: string,
    detail: string,
  ) {
    super(`ops[${opIndex}] (${op}) could not be applied: ${detail}. Nothing was written.`)
    this.name = 'CanvasEditError'
  }
}

// Derived from the stored node schemas rather than restated beside them, so
// a field added to a node type reaches this tool's input for free. Only the
// id and the four geometry fields become optional; `type` stays required
// because it is the discriminator, and the per-type content fields stay
// required because there is no sensible default for a link with no url.
const DRAFT_OPTIONAL = { id: true, x: true, y: true, width: true, height: true } as const
const [textOption, fileOption, linkOption, groupOption] = spatialNodeSchema.options
const nodeDraftSchema = z.discriminatedUnion('type', [
  textOption.partial(DRAFT_OPTIONAL),
  fileOption.partial(DRAFT_OPTIONAL),
  linkOption.partial(DRAFT_OPTIONAL),
  groupOption.partial(DRAFT_OPTIONAL),
])

const edgeDraftSchema = canvasEdgeSchema.partial({ id: true })

/**
 * What `node.patch` may change. Deliberately limited to the geometry/style
 * fields every node type shares plus `label` (which only a group declares) —
 * not the per-type content fields. Patching `label` onto a text node is a
 * silent no-op after re-parse, because the per-type node schemas are not
 * strict and an unrecognized key is stripped rather than rejected. Inherited
 * from the retired `wb_node_patch`, whose only consumer this now is.
 */
const nodePatchFieldsSchema = z
  .object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
    color: canvasColorSchema.optional(),
    label: z.string().optional(),
  })
  .strict()

/** What `edge.patch` may change. Inherited from the retired `wb_edge_patch`. */
const edgePatchFieldsSchema = z
  .object({
    fromNode: nodeIdSchema.optional(),
    toNode: nodeIdSchema.optional(),
    fromSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
    toSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
    fromEnd: z.enum(['none', 'arrow']).optional(),
    toEnd: z.enum(['none', 'arrow']).optional(),
    color: canvasColorSchema.optional(),
    label: z.string().optional(),
  })
  .strict()

/**
 * One step of a batch. The verbs are the ones the retired single-purpose
 * tools carried, so nothing an agent could do before is missing here — plus
 * `node.remove` / `edge.remove`, which had no tool at all: the only way to
 * delete anything used to be a whole-document replace.
 */
const canvasOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('node.add'), node: nodeDraftSchema }).strict(),
  z
    .object({ op: z.literal('node.patch'), id: nodeIdSchema, patch: nodePatchFieldsSchema })
    .strict(),
  z.object({ op: z.literal('node.remove'), id: nodeIdSchema }).strict(),
  z.object({ op: z.literal('edge.add'), edge: edgeDraftSchema }).strict(),
  z
    .object({ op: z.literal('edge.patch'), id: nodeIdSchema, patch: edgePatchFieldsSchema })
    .strict(),
  z.object({ op: z.literal('edge.remove'), id: nodeIdSchema }).strict(),
  z.object({ op: z.literal('node.lock'), id: nodeIdSchema, locked: z.boolean() }).strict(),
  z.object({ op: z.literal('edge.lock'), id: nodeIdSchema, locked: z.boolean() }).strict(),
  z.object({ op: z.literal('tidy'), scope: z.array(nodeIdSchema).min(1).optional() }).strict(),
])

/**
 * 200 is a ceiling on one request, not on a board: a batch past this size is
 * almost always a model looping, and a rejected oversized batch is cheaper
 * to recover from than a half-understood one.
 */
const MAX_OPS = 200

export const canvasEditInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    ops: z.array(canvasOpSchema).min(1).max(MAX_OPS),
  })
  .strict()
type CanvasEditInput = z.infer<typeof canvasEditInputSchema>

const geometryEntrySchema = z
  .object({
    id: nodeIdSchema,
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
  })
  .strict()

const canvasEditOutputSchema = z
  .object({
    documentId: documentIdSchema,
    applied: z.number().int().nonnegative(),
    /**
     * Every element the batch created, changed, moved, locked or deleted.
     * Sorted, so the payload is reproducible across runs rather than
     * carrying Set iteration order.
     */
    touched: z.object({ nodes: z.array(nodeIdSchema), edges: z.array(nodeIdSchema) }).strict(),
    /**
     * Final geometry of every node this batch positioned WITHOUT being told
     * the numbers — an auto-placed add, or a node `tidy` moved. A node whose
     * coordinates the caller supplied is not listed: the caller already
     * knows them.
     */
    geometry: z.array(geometryEntrySchema),
    /** The board after the batch, so no second round trip is needed to read it. */
    snapshot: canvasSnapshotSchema,
  })
  .strict()
type CanvasEditOutput = z.infer<typeof canvasEditOutputSchema>

/**
 * Declared as a function rather than a closure so TypeScript narrows through
 * it: a `never`-returning const arrow does not act as a control-flow
 * terminator, which is what forced the double `if (!parsed.success)` this
 * replaced.
 */
function fail(opIndex: number, op: string, detail: string): never {
  throw new CanvasEditError(opIndex, op, detail)
}

function contentBottomLeft(nodes: readonly SpatialNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 }
  const left = Math.min(...nodes.map((node) => node.x))
  const bottom = Math.max(...nodes.map((node) => node.y + node.height))
  return { x: left, y: bottom + PLACEMENT_GUTTER_PX }
}

/**
 * Lays coordinate-less nodes out in a fixed grid below whatever is already
 * on the board. Deliberately dumb and therefore explainable: an agent can
 * predict where its nodes will land, and `tidy` is one more op away when
 * the result wants refining.
 *
 * ponytail: fixed `PLACEMENT_COLUMNS`-wide grid below existing content;
 * upgrade to free-region packing (`sceneDigest`'s `freeRegions`) if
 * placement quality turns out to matter more than predictability.
 */
class PlacementCursor {
  private started = false
  private baseX = 0
  private x = 0
  private y = 0
  private rowHeight = 0
  private column = 0

  next(nodes: readonly SpatialNode[], width: number, height: number): { x: number; y: number } {
    if (!this.started) {
      // Anchored ONCE, off the board as it stood at the first placement —
      // re-reading it per node would chase the nodes this batch is adding.
      const origin = contentBottomLeft(nodes)
      this.baseX = origin.x
      this.x = origin.x
      this.y = origin.y
      this.started = true
    }
    const at = { x: this.x, y: this.y }
    this.x += width + PLACEMENT_GUTTER_PX
    this.rowHeight = Math.max(this.rowHeight, height)
    this.column += 1
    if (this.column >= PLACEMENT_COLUMNS) {
      this.x = this.baseX
      this.y += this.rowHeight + PLACEMENT_GUTTER_PX
      this.rowHeight = 0
      this.column = 0
    }
    return at
  }
}

function mintId(taken: ReadonlySet<string>, prefix: string): string {
  for (let i = 1; ; i++) {
    const candidate = `${prefix}${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Applies a batch of edits to one spatial canvas as a single transaction:
 * one load, one save, all ops or none.
 *
 * This is the whole spatial-mutation surface. It replaced seven
 * single-purpose tools whose real cost was not their count but their shape —
 * building a ten-node diagram meant twenty-odd round trips, each one a
 * separate load and save, with the model tracking ids across all of them.
 */
export function createCanvasEditTool(deps: ServerDeps) {
  return {
    name: 'wb_canvas_edit' as const,
    description:
      'Apply a batch of edits to a spatial canvas in one transaction: add, patch, remove, lock and tidy nodes and edges. Either every op applies or none does, and a refusal names the op that failed. Node geometry is optional — a node with no x/y/width/height is placed for you and the chosen position is reported back. The result carries the resulting board, so there is no need to read it again.',
    inputSchema: canvasEditInputSchema,
    outputSchema: canvasEditOutputSchema,
    async execute(input: CanvasEditInput): Promise<CanvasEditOutput> {
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const { doc, canvas } = await loadDocument(deps, input.documentId)

      // Same rule as the single-purpose adds this replaced: a markdown
      // document keeps its OKF body in a text node, so spatial ops on it
      // would not fail, they would land beside the body and corrupt it.
      const kind = readDocumentKind(doc)
      if (kind === undefined) {
        writeDocumentKind(doc, 'spatial')
      } else if (kind !== 'spatial') {
        throw new DocumentKindMismatchError(
          input.documentId,
          kind,
          'This edits a JSON Canvas, and its only node holds its OKF body. Write its content through wb_document_set, or its body through wb_body_patch.',
        )
      }

      // Every op runs against these in-memory values; nothing reaches the
      // doc until the last op has applied. That is what makes the batch
      // all-or-nothing — including the lock ops, which would otherwise
      // write through to the doc's sidecar map as they were applied.
      let nodes: SpatialNode[] = [...canvas.nodes]
      let edges: CanvasEdge[] = [...canvas.edges]
      const nodeLocks = new Set(readNodeLocks(doc))
      const edgeLocks = new Set(readEdgeLocks(doc))
      const touchedNodes = new Set<string>()
      const touchedEdges = new Set<string>()
      const geometry = new Map<string, z.infer<typeof geometryEntrySchema>>()
      const cursor = new PlacementCursor()

      const nodeAt = (id: string) => nodes.find((node) => node.id === id)
      const edgeAt = (id: string) => edges.find((edge) => edge.id === id)

      input.ops.forEach((op, index) => {
        const issues = (error: z.ZodError): string =>
          error.issues.map((issue) => issue.message).join('; ')

        switch (op.op) {
          case 'node.add': {
            const draft = op.node
            const id = draft.id ?? mintId(new Set(nodes.map((node) => node.id)), 'n')
            if (nodeAt(id) !== undefined) {
              fail(
                index,
                op.op,
                `node id "${id}" is already on the canvas; patch it or choose another id`,
              )
            }
            const size = DEFAULT_SIZE[draft.type]
            const width = draft.width ?? size.width
            const height = draft.height ?? size.height
            // Partial geometry is treated as none: a node given an x but no
            // y has no position, and guessing the other half would put it
            // somewhere the caller did not ask for either.
            const positioned = draft.x !== undefined && draft.y !== undefined
            const at = positioned
              ? { x: draft.x as number, y: draft.y as number }
              : cursor.next(nodes, width, height)

            const parsed = spatialNodeSchema.safeParse({ ...draft, id, ...at, width, height })
            if (!parsed.success) fail(index, op.op, issues(parsed.error))
            nodes = [...nodes, parsed.data]
            touchedNodes.add(id)
            if (!positioned) geometry.set(id, { id, ...at, width, height })
            return
          }

          case 'node.patch': {
            const node = nodeAt(op.id)
            if (node === undefined) fail(index, op.op, `node "${op.id}" is not on the canvas`)
            if (nodeLocks.has(op.id)) {
              fail(index, op.op, `node "${op.id}" is locked; unlock it with a node.lock op first`)
            }
            const parsed = spatialNodeSchema.safeParse({ ...node, ...op.patch })
            if (!parsed.success) fail(index, op.op, issues(parsed.error))
            const updated = parsed.data
            nodes = nodes.map((existing) => (existing.id === op.id ? updated : existing))
            touchedNodes.add(op.id)
            return
          }

          case 'node.remove': {
            if (nodeAt(op.id) === undefined)
              fail(index, op.op, `node "${op.id}" is not on the canvas`)
            if (nodeLocks.has(op.id)) {
              fail(index, op.op, `node "${op.id}" is locked; unlock it with a node.lock op first`)
            }
            // Edges touching a removed node go with it. Left behind they are
            // a canvas spatialCanvasSchema refuses on the next read, so
            // "apply exactly the op I was handed" would store a board that
            // cannot be loaded.
            for (const edge of edges) {
              if (edge.fromNode === op.id || edge.toNode === op.id) touchedEdges.add(edge.id)
            }
            edges = edges.filter((edge) => edge.fromNode !== op.id && edge.toNode !== op.id)
            nodes = nodes.filter((node) => node.id !== op.id)
            nodeLocks.delete(op.id)
            touchedNodes.add(op.id)
            return
          }

          case 'edge.add': {
            const draft = op.edge
            const id = draft.id ?? mintId(new Set(edges.map((edge) => edge.id)), 'e')
            if (edgeAt(id) !== undefined) {
              fail(
                index,
                op.op,
                `edge id "${id}" is already on the canvas; patch it or choose another id`,
              )
            }
            for (const endpoint of [draft.fromNode, draft.toNode]) {
              if (nodeAt(endpoint) === undefined) {
                fail(
                  index,
                  op.op,
                  `endpoint "${endpoint}" is not on the canvas; add that node first`,
                )
              }
            }
            const parsed = canvasEdgeSchema.safeParse({ ...draft, id })
            if (!parsed.success) fail(index, op.op, issues(parsed.error))
            edges = [...edges, parsed.data]
            touchedEdges.add(id)
            return
          }

          case 'edge.patch': {
            const edge = edgeAt(op.id)
            if (edge === undefined) fail(index, op.op, `edge "${op.id}" is not on the canvas`)
            if (edgeLocks.has(op.id)) {
              fail(index, op.op, `edge "${op.id}" is locked; unlock it with an edge.lock op first`)
            }
            const merged = { ...edge, ...op.patch }
            for (const endpoint of [merged.fromNode, merged.toNode]) {
              if (nodeAt(endpoint) === undefined) {
                fail(index, op.op, `endpoint "${endpoint}" is not on the canvas`)
              }
            }
            const parsed = canvasEdgeSchema.safeParse(merged)
            if (!parsed.success) fail(index, op.op, issues(parsed.error))
            const updated = parsed.data
            edges = edges.map((existing) => (existing.id === op.id ? updated : existing))
            touchedEdges.add(op.id)
            return
          }

          case 'edge.remove': {
            if (edgeAt(op.id) === undefined)
              fail(index, op.op, `edge "${op.id}" is not on the canvas`)
            if (edgeLocks.has(op.id)) {
              fail(index, op.op, `edge "${op.id}" is locked; unlock it with an edge.lock op first`)
            }
            edges = edges.filter((edge) => edge.id !== op.id)
            edgeLocks.delete(op.id)
            touchedEdges.add(op.id)
            return
          }

          case 'node.lock': {
            if (nodeAt(op.id) === undefined)
              fail(index, op.op, `node "${op.id}" is not on the canvas`)
            if (op.locked) nodeLocks.add(op.id)
            else nodeLocks.delete(op.id)
            touchedNodes.add(op.id)
            return
          }

          case 'edge.lock': {
            if (edgeAt(op.id) === undefined)
              fail(index, op.op, `edge "${op.id}" is not on the canvas`)
            if (op.locked) edgeLocks.add(op.id)
            else edgeLocks.delete(op.id)
            touchedEdges.add(op.id)
            return
          }

          case 'tidy': {
            // Locks bind tidy exactly as they bind the editor: a locked node
            // is a fixed obstacle it routes around, never one it moves.
            const moved = tidyNodes(nodes, {
              scope: op.scope === undefined ? undefined : new Set(op.scope),
              locked: (id) => nodeLocks.has(id),
            })
            const target = new Map(moved.map((move) => [move.id, move]))
            nodes = nodes.map((node) => {
              const move = target.get(node.id)
              if (move === undefined) return node
              geometry.set(node.id, {
                id: node.id,
                x: move.x,
                y: move.y,
                width: node.width,
                height: node.height,
              })
              touchedNodes.add(node.id)
              return { ...node, x: move.x, y: move.y }
            })
            return
          }
        }
      })

      const candidate: SpatialCanvas = { nodes, edges }
      const parsed = spatialCanvasSchema.safeParse(candidate)
      if (!parsed.success) {
        throw new CanvasEditError(
          input.ops.length - 1,
          'batch',
          `the resulting canvas is not valid: ${parsed.error.issues
            .map((issue) => issue.message)
            .join('; ')}`,
        )
      }

      // Locks are written only now, after every op has applied — see the
      // working-copy comment above.
      for (const node of parsed.data.nodes) setNodeLock(doc, node.id, nodeLocks.has(node.id))
      for (const edge of parsed.data.edges) setEdgeLock(doc, edge.id, edgeLocks.has(edge.id))
      await saveDocumentBodySnapshot(deps, input.documentId, doc, parsed.data)

      return {
        documentId: input.documentId,
        applied: input.ops.length,
        touched: {
          nodes: [...touchedNodes].sort(),
          edges: [...touchedEdges].sort(),
        },
        geometry: [...geometry.values()].sort((a, b) => a.id.localeCompare(b.id)),
        snapshot: projectCanvasSnapshot(input.documentId, parsed.data, nodeLocks, edgeLocks),
      }
    },
  }
}
