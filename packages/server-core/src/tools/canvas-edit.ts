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
import type { CanvasOpSummaryInput, ServerDeps } from '../server-deps.js'
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
const GEOMETRY_OPTIONAL = { x: true, y: true, width: true, height: true } as const
const DRAFT_OPTIONAL = { id: true, ...GEOMETRY_OPTIONAL } as const
const [textOption, fileOption, linkOption, groupOption] = spatialNodeSchema.options
const nodeDraftSchema = z.discriminatedUnion('type', [
  textOption.partial(DRAFT_OPTIONAL),
  fileOption.partial(DRAFT_OPTIONAL),
  linkOption.partial(DRAFT_OPTIONAL),
  groupOption.partial(DRAFT_OPTIONAL),
])

/**
 * A node as `region.set` declares it: geometry still optional, but the id is
 * REQUIRED. Reconciliation is matching by id — a declared node with no id
 * could only ever be a create, which is `node.add`'s job, and would make the
 * op non-idempotent.
 */
const regionNodeSchema = z.discriminatedUnion('type', [
  textOption.partial(GEOMETRY_OPTIONAL),
  fileOption.partial(GEOMETRY_OPTIONAL),
  linkOption.partial(GEOMETRY_OPTIONAL),
  groupOption.partial(GEOMETRY_OPTIONAL),
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
  /**
   * "This group should look like this." The ONE declarative op, and so the
   * only one that deletes something it was not told about.
   *
   * Scope is STRICT containment in `within`'s stored box. That rule is what
   * makes the boundary safe rather than a judgement call: a node straddling
   * the edge — a human mid-drag — is not enclosed, so it is out of scope and
   * survives. Edges follow the same rule: in scope only when BOTH endpoints
   * are.
   *
   * A declared node that already exists is MERGED, not replaced, so omitting
   * geometry leaves it where it is and re-applying the same region is a
   * no-op. The cost of that choice is that this op cannot clear a field;
   * use `node.patch` for that.
   */
  z
    .object({
      op: z.literal('region.set'),
      within: nodeIdSchema,
      nodes: z.array(regionNodeSchema),
      edges: z.array(canvasEdgeSchema),
    })
    .strict(),
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
    /**
     * Move a watching browser's viewport onto what this batch touched.
     * Defaults to true: an agent editing a board a human is looking at
     * should not leave them hunting for the change. Set false for
     * housekeeping edits that do not deserve to steal someone's view.
     */
    follow: z.boolean().optional(),
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

/**
 * One human-readable line for the toast a browser shows. Counted from the
 * OPS rather than from `touched`, because "added 3 nodes" and "moved 3
 * nodes" are the same set of ids and a human needs to know which happened.
 */
function summarizeOps(ops: readonly CanvasOpSummaryInput[]): string {
  const counts = { added: 0, changed: 0, removed: 0, locked: 0, unlocked: 0 }
  let tidied = false
  for (const op of ops) {
    if (op.op === 'node.add' || op.op === 'edge.add') counts.added += 1
    else if (op.op === 'node.patch' || op.op === 'edge.patch') counts.changed += 1
    else if (op.op === 'node.remove' || op.op === 'edge.remove') counts.removed += 1
    else if (op.op === 'node.lock' || op.op === 'edge.lock') {
      if (op.locked) counts.locked += 1
      else counts.unlocked += 1
    } else if (op.op === 'tidy') tidied = true
  }
  const parts: string[] = []
  if (counts.added > 0) parts.push(`added ${counts.added}`)
  if (counts.changed > 0) parts.push(`changed ${counts.changed}`)
  if (counts.removed > 0) parts.push(`removed ${counts.removed}`)
  if (counts.locked > 0) parts.push(`locked ${counts.locked}`)
  if (counts.unlocked > 0) parts.push(`unlocked ${counts.unlocked}`)
  if (tidied) parts.push('tidied the layout')
  // `ops` is `.min(1)`, and every op kind above contributes, so this is
  // unreachable rather than a fallback anyone should see.
  return parts.length === 0 ? 'edited the canvas' : parts.join(', ')
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

/**
 * Lays coordinate-less nodes out INSIDE a box, wrapping at its right edge.
 *
 * `region.set` cannot use the board-level cursor: that one places below all
 * existing content, which for a region op lands the node outside the very
 * region it was declared in — and therefore out of scope on the next call,
 * so the op would not be idempotent.
 *
 * ponytail: rows from the box's top-left, and a node wider than the box
 * overflows it rather than being shrunk. Pack properly if regions turn out to
 * be used for dense layouts.
 */
function placeWithin(
  box: { x: number; y: number; width: number; height: number },
  sizes: readonly { width: number; height: number }[],
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  let x = box.x + PLACEMENT_GUTTER_PX
  let y = box.y + PLACEMENT_GUTTER_PX
  let rowHeight = 0
  for (const size of sizes) {
    if (x !== box.x + PLACEMENT_GUTTER_PX && x + size.width > box.x + box.width) {
      x = box.x + PLACEMENT_GUTTER_PX
      y += rowHeight + PLACEMENT_GUTTER_PX
      rowHeight = 0
    }
    out.push({ x, y })
    x += size.width + PLACEMENT_GUTTER_PX
    rowHeight = Math.max(rowHeight, size.height)
  }
  return out
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

          case 'region.set': {
            const group = nodeAt(op.within)
            if (group === undefined || group.type !== 'group') {
              fail(
                index,
                op.op,
                `"${op.within}" is not a group on the canvas; region.set needs one to bound the region`,
              )
            }
            const bounds = group
            const encloses = (node: SpatialNode): boolean =>
              node.id !== bounds.id &&
              node.x >= bounds.x &&
              node.y >= bounds.y &&
              node.x + node.width <= bounds.x + bounds.width &&
              node.y + node.height <= bounds.y + bounds.height

            const inScope = nodes.filter(encloses)
            const inScopeIds = new Set(inScope.map((node) => node.id))
            const inScopeEdges = edges.filter(
              (edge) => inScopeIds.has(edge.fromNode) && inScopeIds.has(edge.toNode),
            )
            // Refused up front, before anything is removed: this op deletes by
            // OMISSION, and silently dropping a locked element would be the
            // worst possible reading of that.
            for (const node of inScope) {
              if (nodeLocks.has(node.id)) {
                fail(index, op.op, `node "${node.id}" inside the region is locked`)
              }
            }
            for (const edge of inScopeEdges) {
              if (edgeLocks.has(edge.id)) {
                fail(index, op.op, `edge "${edge.id}" inside the region is locked`)
              }
            }

            const declaredNodes = new Set(op.nodes.map((node) => node.id))
            const declaredEdges = new Set(op.edges.map((edge) => edge.id))
            const dropped = inScope.filter((node) => !declaredNodes.has(node.id))
            const droppedIds = new Set(dropped.map((node) => node.id))
            for (const node of dropped) {
              touchedNodes.add(node.id)
              nodeLocks.delete(node.id)
            }
            // An edge goes if it was in scope and undeclared, OR if either
            // endpoint just went — a dangling edge stores a canvas the next
            // read refuses.
            // Scoped to THIS op. `touchedEdges` spans the whole batch, so an
            // edge an earlier op merely touched is not this region's to delete.
            const removedEdges = new Set<string>()
            for (const edge of edges) {
              const strandedBy = droppedIds.has(edge.fromNode) || droppedIds.has(edge.toNode)
              const undeclaredInRegion =
                inScopeEdges.some((candidate) => candidate.id === edge.id) &&
                !declaredEdges.has(edge.id)
              if (strandedBy || undeclaredInRegion) {
                removedEdges.add(edge.id)
                touchedEdges.add(edge.id)
                edgeLocks.delete(edge.id)
              }
            }
            nodes = nodes.filter((node) => !droppedIds.has(node.id))
            edges = edges.filter((edge) => !removedEdges.has(edge.id))

            // Placement for the declared nodes that carry no position, all at
            // once so they tile rather than stack.
            const needPlacing = op.nodes.filter(
              (node) =>
                nodeAt(node.id) === undefined && (node.x === undefined || node.y === undefined),
            )
            const placements = placeWithin(
              bounds,
              needPlacing.map((node) => ({
                width: node.width ?? DEFAULT_SIZE[node.type].width,
                height: node.height ?? DEFAULT_SIZE[node.type].height,
              })),
            )
            const placementFor = new Map(
              needPlacing.map((node, at) => [node.id, placements[at]] as const),
            )

            for (const declared of op.nodes) {
              const existing = nodeAt(declared.id)
              const size = DEFAULT_SIZE[declared.type]
              const width = declared.width ?? existing?.width ?? size.width
              const height = declared.height ?? existing?.height ?? size.height
              const placed = placementFor.get(declared.id)
              const at =
                declared.x !== undefined && declared.y !== undefined
                  ? { x: declared.x, y: declared.y }
                  : existing !== undefined
                    ? { x: existing.x, y: existing.y }
                    : (placed ?? { x: bounds.x, y: bounds.y })
              // MERGED over what is already there, not replaced: that is what
              // makes re-applying the same region a no-op.
              const parsed = spatialNodeSchema.safeParse({
                ...(existing ?? {}),
                ...declared,
                ...at,
                width,
                height,
              })
              if (!parsed.success) fail(index, op.op, issues(parsed.error))
              const next = parsed.data
              // A declaration names what the region CONTAINS, so its result has
              // to be inside it. Without this an op scoped to one group could
              // move any node on the board — and since the lock preflight only
              // walks what is in scope, a locked one at that.
              if (!encloses(next)) {
                fail(
                  index,
                  op.op,
                  `node "${declared.id}" would not be inside "${bounds.id}"; region.set declares what the region contains`,
                )
              }
              nodes =
                existing === undefined
                  ? [...nodes, next]
                  : nodes.map((node) => (node.id === declared.id ? next : node))
              touchedNodes.add(declared.id)
              if (placed !== undefined) {
                geometry.set(declared.id, { id: declared.id, ...placed, width, height })
              }
            }

            for (const declared of op.edges) {
              for (const endpoint of [declared.fromNode, declared.toNode]) {
                const node = nodeAt(endpoint)
                if (node === undefined) {
                  fail(index, op.op, `endpoint "${endpoint}" is not on the canvas`)
                }
                // Same rule as the nodes above, and the same reason: an edge is
                // in this region only when BOTH its endpoints are.
                if (!encloses(node)) {
                  fail(
                    index,
                    op.op,
                    `endpoint "${endpoint}" is not inside "${bounds.id}"; an edge is in the region only when both ends are`,
                  )
                }
              }
              const parsed = canvasEdgeSchema.safeParse(declared)
              if (!parsed.success) fail(index, op.op, issues(parsed.error))
              const next = parsed.data
              edges =
                edgeAt(declared.id) === undefined
                  ? [...edges, next]
                  : edges.map((edge) => (edge.id === declared.id ? next : edge))
              touchedEdges.add(declared.id)
            }
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

      const touched = {
        nodes: [...touchedNodes].sort(),
        edges: [...touchedEdges].sort(),
      }

      // Only now, with the write committed. A human must never be shown an
      // edit that was refused, so nothing above this line notifies.
      //
      // Both calls are wrapped because the batch is already on disk by the
      // time anyone is told: letting a broken socket surface as a tool error
      // would report a failure for an edit that succeeded. The
      // implementation is expected to handle its own transport errors — this
      // is the belt, and server-core has no logger of its own to record it.
      const notifier = deps.clientNotifier
      if (notifier !== undefined) {
        try {
          notifier.agentActivity({
            workspaceId: input.workspaceId,
            documentId: input.documentId,
            touched,
            summary: summarizeOps(input.ops),
          })
        } catch {
          // best effort
        }
        // An empty `elementIds` with `mode: 'fit'` fits the WHOLE board,
        // which is a jarring jump for an edit that only touched an edge —
        // so a batch that moved no node moves no viewport either.
        if (input.follow !== false && touched.nodes.length > 0) {
          try {
            await notifier.requestViewport({
              workspaceId: input.workspaceId,
              documentId: input.documentId,
              mode: 'fit',
              elementIds: touched.nodes,
              animate: true,
            })
          } catch {
            // best effort
          }
        }
      }

      return {
        documentId: input.documentId,
        applied: input.ops.length,
        touched,
        geometry: [...geometry.values()].sort((a, b) => a.id.localeCompare(b.id)),
        snapshot: projectCanvasSnapshot(input.documentId, parsed.data, nodeLocks, edgeLocks),
      }
    },
  }
}
