import {
  constantRatioMeasureText,
  type MeasureText,
  naturalNodeContentSize,
  SPATIAL_THEME_GEOMETRY,
  tidyNodes,
} from '@kamiazya/whiteboard-canvas-render'
import {
  readDocumentKind,
  readEdgeLocks,
  readNodeLocks,
  setEdgeLock,
  setNodeLock,
  writeDocumentKind,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  annotationIdSchema,
  type CanvasComment,
  type CanvasEdge,
  canvasCommentSchema,
  canvasEdgeSchema,
  documentIdSchema,
  edgePatchFieldsSchema,
  extensionFacetsSchema,
  nodeIdSchema,
  nodePatchFieldsSchema,
  nonnegativeIntegerSchema,
  proposalSchema,
  type SpatialCanvas,
  type SpatialNode,
  spatialCanvasSchema,
  spatialNodeSchema,
  workspaceIdSchema,
  type XWhiteboard,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { MCP_SCENE_APPEARANCE } from '../render/compose-canvas-scene.js'
import type { CanvasOpSummaryInput, ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { isProposableOp, storeCanvasProposal } from './canvas-propose.js'
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
 * The height a node needs for its own text, never less than the default it
 * would otherwise get.
 *
 * GROW-ONLY on purpose. A one-word node measures about 32px, and shrinking
 * every short node to that would redraw how a whole diagram looks for a
 * defect that is only ever about content NOT FITTING. The default stays the
 * floor; this only lifts it.
 *
 * Position does not matter here: `naturalNodeContentSize` lays the content
 * out unbounded, so only the width it wraps against is an input. That is what
 * breaks the circularity — placement needs a height, and the height needs a
 * width, not a position.
 */
function fittedHeight(node: SpatialNode, measure: MeasureText, fallback: number): number {
  const natural = naturalNodeContentSize(node, { measure, appearance: MCP_SCENE_APPEARANCE })
  return Math.max(fallback, natural.h + 2 * SPATIAL_THEME_GEOMETRY.paddingPx)
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

/**
 * The node extension as a WRITER declares it: one flat object instead of
 * the stored two-variant union, narrowed to the stored shape on parse.
 *
 * Two reasons, one of them measured. The stored schema `.catch`es an
 * unrecognised extension so a canvas stays readable, which on the write
 * side would silently DROP a broken embed a caller just sent; here a
 * `kind: "embed"` with no document is refused by name. And the stored
 * union is emitted inline into the tool's input once per node type per op
 * — eight times, 487 bytes each — where this shape is 290, on a table a
 * model reads on every turn.
 */
const nodeExtensionWriteSchema = z
  .object({
    kind: z.literal('embed').optional(),
    documentId: documentIdSchema.optional(),
    versionRef: z.string().min(1).optional(),
    facets: extensionFacetsSchema.optional(),
  })
  .strict()
  .refine((value) => (value.kind === 'embed') === (value.documentId !== undefined), {
    message: 'an embed names the document it embeds: kind "embed" and documentId go together',
  })
  .transform((value): XWhiteboard => {
    if (value.kind === 'embed' && value.documentId !== undefined) {
      return {
        kind: 'embed',
        documentId: value.documentId,
        ...(value.versionRef === undefined ? {} : { versionRef: value.versionRef }),
        ...(value.facets === undefined ? {} : { facets: value.facets }),
      }
    }
    return value.facets === undefined ? {} : { facets: value.facets }
  })
const WRITE_EXTENSION = { 'x-whiteboard': nodeExtensionWriteSchema.optional() } as const

const nodeDraftSchema = z.discriminatedUnion('type', [
  textOption.partial(DRAFT_OPTIONAL).extend(WRITE_EXTENSION),
  fileOption.partial(DRAFT_OPTIONAL).extend(WRITE_EXTENSION),
  linkOption.partial(DRAFT_OPTIONAL).extend(WRITE_EXTENSION),
  groupOption.partial(DRAFT_OPTIONAL).extend(WRITE_EXTENSION),
])

/**
 * A node as `region.set` declares it: geometry still optional, but the id is
 * REQUIRED. Reconciliation is matching by id — a declared node with no id
 * could only ever be a create, which is `node.add`'s job, and would make the
 * op non-idempotent.
 */
const regionNodeSchema = z.discriminatedUnion('type', [
  textOption.partial(GEOMETRY_OPTIONAL).extend(WRITE_EXTENSION),
  fileOption.partial(GEOMETRY_OPTIONAL).extend(WRITE_EXTENSION),
  linkOption.partial(GEOMETRY_OPTIONAL).extend(WRITE_EXTENSION),
  groupOption.partial(GEOMETRY_OPTIONAL).extend(WRITE_EXTENSION),
])

const edgeDraftSchema = canvasEdgeSchema.partial({ id: true })

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
  /**
   * A line-range splice of a text node's body, `[startLine, endLine]`
   * inclusive and 0-indexed. `node.patch`'s `text` replaces the whole body;
   * this replaces part of it, so a caller editing one line of a long note
   * sends that line. Retired `wb_body_patch` into this tool: as an op it
   * batches with everything else, and it falls under the propose-by-default
   * rule that tool had no mode for.
   */
  z
    .object({
      op: z.literal('node.splice'),
      id: nodeIdSchema,
      startLine: nonnegativeIntegerSchema,
      endLine: nonnegativeIntegerSchema,
      replacement: z.string(),
    })
    .strict()
    .refine((value) => value.startLine <= value.endLine, {
      message: 'startLine must be <= endLine',
    }),
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
   * The annotation layer (ADR-0024). A draft may omit the id (minted) and
   * the anchor point — a comment about a NODE names `targetNodeId` and the
   * server anchors it at that node's top-right corner. `createdAt` defaults
   * to now, stamped by the server so the record orders without trusting
   * every caller's clock format.
   */
  z
    .object({
      op: z.literal('comment.add'),
      comment: canvasCommentSchema.partial({ id: true, x: true, y: true }),
    })
    .strict(),
  /**
   * Resolution keeps the record in the document (the conversation is the
   * point); `resolved: false` reopens. There is deliberately NO remove op:
   * resolving is the only way to close a comment, for a person in the
   * editor and for an agent alike (ADR-0025 decision 2) — a verb one side
   * had and the other did not would let an agent erase feedback a person
   * could only close.
   */
  z
    .object({
      op: z.literal('comment.resolve'),
      id: nodeIdSchema,
      resolved: z.boolean().optional(),
    })
    .strict(),
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
      nodes: z
        .array(regionNodeSchema)
        .describe(
          'Everything the group contains, by id; a node inside it that is not listed is removed. Omit x/y and a node is placed inside, and the group grows to fit.',
        ),
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
     * Whether this batch CHANGES the document or PROPOSES a change to it
     * (ADR-0029). A proposal is stored beside the content, drawn on the live
     * document, and adopted or dismissed by a person.
     *
     * **The default is decided by what the batch CARRIES, not by who is
     * calling.** Content — node and edge adds, patches and removes — is
     * proposed, because nobody watches an agent type and there is no moment
     * at which a person could object (decision 3). A batch carrying anything
     * else applies: `comment.*` is the annotation layer, a lock is a claim on
     * a document rather than a change to it, and `tidy`/`region.set` have no
     * anchor to follow — the same line the layer already drew when it said
     * which verbs a proposal can carry.
     *
     * A default that refused those instead would refuse a verb this tool
     * supports, and one of its callers is the widget's comment box: a person
     * typing there would get an error rather than a comment.
     *
     * A MIXED batch applies, because the batch is all-or-nothing and
     * splitting it would be a third thing neither mode means.
     *
     * `apply` is therefore still what a surface a person is looking at
     * should pass explicitly — the product's drawing skills do, since a
     * person who asked for a drawing right now is the case decision 3
     * exempts.
     */
    mode: z.enum(['apply', 'propose']).optional(),
    /**
     * Add to the proposal already open under this id instead of opening a
     * new one — decision 8's "one request, not one call". Only meaningful
     * with `mode: 'propose'`; a batch that touches an element the proposal
     * already carries REPLACES that change rather than stacking a second
     * opinion beside it.
     */
    proposalId: annotationIdSchema.optional(),
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
    touched: z
      .object({
        nodes: z.array(nodeIdSchema),
        edges: z.array(nodeIdSchema),
        comments: z.array(nodeIdSchema),
      })
      .strict(),
    /**
     * Final geometry of every node this batch positioned WITHOUT being told
     * the numbers — an auto-placed add, or a node `tidy` moved. A node whose
     * coordinates the caller supplied is not listed: the caller already
     * knows them.
     */
    geometry: z.array(geometryEntrySchema),
    /** The board after the batch, so no second round trip is needed to read it. */
    snapshot: canvasSnapshotSchema,
    /**
     * What was proposed, present only in `propose` mode. The whole proposal
     * rather than a summary of it: the caller does not know the ids minted
     * or the geometry placed, and this is the same schema the document
     * stores, so there is no second shape to keep in step.
     */
    proposed: proposalSchema.optional(),
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
  const counts = { added: 0, changed: 0, removed: 0, locked: 0, unlocked: 0, commented: 0 }
  let tidied = false
  let resolvedComments = 0
  for (const op of ops) {
    if (op.op === 'node.add' || op.op === 'edge.add') counts.added += 1
    else if (op.op === 'node.patch' || op.op === 'edge.patch') counts.changed += 1
    else if (op.op === 'comment.add') counts.commented += 1
    else if (op.op === 'comment.resolve') resolvedComments += 1
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
  if (counts.commented > 0) parts.push(`commented ${counts.commented}`)
  if (resolvedComments > 0) parts.push(`resolved ${resolvedComments}`)
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

type Rect = { x: number; y: number; width: number; height: number }

/** Two boxes closer than the gutter count as touching, so packing keeps it. */
function crowds(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width + PLACEMENT_GUTTER_PX &&
    b.x < a.x + a.width + PLACEMENT_GUTTER_PX &&
    a.y < b.y + b.height + PLACEMENT_GUTTER_PX &&
    b.y < a.y + a.height + PLACEMENT_GUTTER_PX
  )
}

/**
 * Lays coordinate-less nodes out INSIDE a box, in rows from its top-left,
 * around what the box already holds.
 *
 * `region.set` cannot use the board-level cursor: that one places below all
 * existing content, which for a region op lands the node outside the very
 * region it was declared in — and therefore out of scope on the next call,
 * so the op would not be idempotent.
 *
 * `occupied` is what the region keeps. Without it the first placement
 * started from the top-left as if the group were empty and landed on the
 * box already there; measured on the lane, a model then spent a call moving
 * it. Each row is walked past whatever crowds the candidate, and when the
 * row is full the next starts under the lowest of what blocked it.
 *
 * ponytail: a node wider than the box overflows it rather than being shrunk
 * (the caller grows the box). Pack properly if regions turn out to be used
 * for dense layouts.
 */
function placeWithin(
  box: Rect,
  sizes: readonly { width: number; height: number }[],
  occupied: readonly Rect[],
): { x: number; y: number }[] {
  const taken: Rect[] = [...occupied]
  const left = box.x + PLACEMENT_GUTTER_PX
  const right = box.x + box.width
  const out: { x: number; y: number }[] = []
  for (const size of sizes) {
    let y = box.y + PLACEMENT_GUTTER_PX
    for (;;) {
      let x = left
      let nextRow: number | undefined
      let at: Rect | undefined
      for (;;) {
        const candidate = { x, y, ...size }
        const hit = taken.find((rect) => crowds(candidate, rect))
        if (hit === undefined) {
          at = candidate
          break
        }
        const below = hit.y + hit.height + PLACEMENT_GUTTER_PX
        nextRow = nextRow === undefined ? below : Math.min(nextRow, below)
        x = hit.x + hit.width + PLACEMENT_GUTTER_PX
        if (x + size.width > right) break
      }
      if (at !== undefined) {
        out.push({ x: at.x, y: at.y })
        taken.push(at)
        break
      }
      // Every hit sits at or below y with the gutter, so this strictly
      // advances and the walk ends once y is under everything taken.
      y = nextRow ?? y + size.height + PLACEMENT_GUTTER_PX
    }
  }
  return out
}

/**
 * Why a declared node is outside its region, with the way out. A model that
 * was told only "would not be inside" shrank every box in the group to fit
 * (lane, 2026-09); the number it is over by and the cheaper repairs are what
 * it needed.
 */
function outsideDetail(
  id: string,
  node: { x: number; y: number; width: number; height: number },
  bounds: { id: string; x: number; y: number; width: number; height: number },
): string {
  const over: string[] = []
  if (node.x < bounds.x) over.push(`left edge ${node.x} is before the group's ${bounds.x}`)
  if (node.y < bounds.y) over.push(`top edge ${node.y} is above the group's ${bounds.y}`)
  const right = node.x + node.width
  const groupRight = bounds.x + bounds.width
  if (right > groupRight) over.push(`right edge ${right} is past the group's ${groupRight}`)
  const bottom = node.y + node.height
  const groupBottom = bounds.y + bounds.height
  if (bottom > groupBottom) over.push(`bottom edge ${bottom} is past the group's ${groupBottom}`)
  return `node "${id}" would not be inside "${bounds.id}": ${over.join(', ')}. Widen "${bounds.id}" with node.patch, move the node, or omit its x/y to have it placed inside (the group grows to fit what is placed)`
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
      'Apply a batch of edits to a spatial canvas in one transaction: add, patch, remove, lock and tidy nodes and edges, and add or resolve comments (the annotation layer; comments are closed, never removed). Either every op applies or none does, and a refusal names the op that failed. Node geometry is optional — a node with no x/y/width/height is placed for you and the chosen position is reported back. The result carries the resulting board, so there is no need to read it again. A batch of CONTENT changes is stored as a proposal for a person to adopt or dismiss rather than changing the document — that is the default, because nobody watches you type. Pass mode:"apply" to change the document directly, which is what to do when a person just asked you to draw. A batch carrying anything a proposal cannot represent — comments, locks, tidy, region.set — applies whatever the mode, since those are not content. Pass proposalId to keep several calls in one proposal.',
    inputSchema: canvasEditInputSchema,
    outputSchema: canvasEditOutputSchema,
    async execute(input: CanvasEditInput): Promise<CanvasEditOutput> {
      // An omitted mode proposes only a batch every op of which COULD be
      // proposed; see the field's own note for why that line and not
      // "propose unless told otherwise".
      const proposing =
        input.mode === undefined
          ? input.ops.every((op) => isProposableOp(op.op))
          : input.mode === 'propose'
      // Only an EXPLICIT propose can be refused: the default never chooses
      // to propose a batch it would then have to reject.
      if (input.mode === 'propose') {
        const refused = input.ops.findIndex((op) => !isProposableOp(op.op))
        if (refused >= 0) {
          fail(
            refused,
            input.ops[refused]?.op ?? 'unknown',
            'a proposal cannot carry this verb: it has no single anchor to follow, ' +
              'or it changes what it was not asked about, so nobody could adopt part of it',
          )
        }
      }
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const { doc, canvas } = await loadDocument(deps, input.workspaceId, input.documentId)

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
          "This edits a JSON Canvas, and its only node holds its OKF body. Write its content through `wb_workspace_edit`'s `document.set` op, or a passage of its body through wb_body_edit.",
        )
      }

      // Every op runs against these in-memory values; nothing reaches the
      // doc until the last op has applied. That is what makes the batch
      // all-or-nothing — including the lock ops, which would otherwise
      // write through to the doc's sidecar map as they were applied.
      let nodes: SpatialNode[] = [...canvas.nodes]
      let edges: CanvasEdge[] = [...canvas.edges]
      let comments: CanvasComment[] = [...(canvas['x-whiteboard']?.comments ?? [])]
      const nodeLocks = new Set(readNodeLocks(doc))
      const edgeLocks = new Set(readEdgeLocks(doc))
      const touchedNodes = new Set<string>()
      const touchedEdges = new Set<string>()
      const touchedComments = new Set<string>()
      const geometry = new Map<string, z.infer<typeof geometryEntrySchema>>()
      const cursor = new PlacementCursor()

      // Resolved once, and only when some op actually creates a text node
      // without naming a height — the composition root's measurer parses a
      // font on first use, and a batch of patches should not pay for that.
      // `region.set` is deliberately NOT included: what it declares must fit
      // inside its group, so growing a node there could refuse the very op
      // that asked for it. A node created there keeps the flat default.
      const wantsFit = input.ops.some(
        (op) => op.op === 'node.add' && op.node.type === 'text' && op.node.height === undefined,
      )
      const measure: MeasureText | undefined = wantsFit
        ? ((await deps.measure?.()) ?? constantRatioMeasureText)
        : undefined

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
            const height =
              draft.height ??
              (draft.type === 'text' && measure !== undefined
                ? fittedHeight(
                    { ...draft, id, x: 0, y: 0, width, height: size.height },
                    measure,
                    size.height,
                  )
                : size.height)
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
            // The per-type node schemas are non-strict on purpose — JSON
            // Canvas 1.0 lets a document carry another tool's extension keys,
            // and refusing them would make those documents unreadable. The
            // cost is that a patch key the TARGET's type does not have is
            // stripped by the re-parse above rather than rejected, so the
            // write would report success over a document it did not change.
            // `label` on a text node is the case that exists today: it is on
            // the patch allowlist because a group has one.
            //
            // Caught here rather than by narrowing the allowlist per type,
            // because one check covers every key and every type — including
            // whichever content field a later increment allows.
            const dropped = Object.keys(op.patch).filter((key) => !(key in updated))
            if (dropped.length > 0) {
              fail(
                index,
                op.op,
                `a ${updated.type} node has no ${dropped.join(', ')} — the patch would have been ` +
                  'accepted and silently dropped, so it is refused instead',
              )
            }
            nodes = nodes.map((existing) => (existing.id === op.id ? updated : existing))
            touchedNodes.add(op.id)
            return
          }

          case 'node.splice': {
            const node = nodeAt(op.id)
            if (node === undefined) fail(index, op.op, `node "${op.id}" is not on the canvas`)
            if (nodeLocks.has(op.id)) {
              fail(index, op.op, `node "${op.id}" is locked; unlock it with a node.lock op first`)
            }
            if (node.type !== 'text') {
              fail(
                index,
                op.op,
                `a ${node.type} node holds no text to splice; only a text node does`,
              )
            }
            const lines = node.text.split('\n')
            // Refused rather than clamped: clamping would apply part of the
            // splice and report success, which is the failure the codec's
            // own parsers refuse to degrade into.
            if (op.startLine >= lines.length || op.endLine >= lines.length) {
              fail(
                index,
                op.op,
                `range [${op.startLine}, ${op.endLine}] is out of bounds for a ${lines.length}-line body`,
              )
            }
            const spliced = [
              ...lines.slice(0, op.startLine),
              ...op.replacement.split('\n'),
              ...lines.slice(op.endLine + 1),
            ].join('\n')
            const parsed = spatialNodeSchema.safeParse({ ...node, text: spliced })
            if (!parsed.success) fail(index, op.op, issues(parsed.error))
            nodes = nodes.map((existing) => (existing.id === op.id ? parsed.data : existing))
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
            // Reassigned once if placement grows the group, below; every
            // read of the boundary goes through it so the grown size is what
            // the rest of the op is held to.
            let bounds = group
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
            const sizeOf = (node: (typeof op.nodes)[number]) => ({
              width: node.width ?? nodeAt(node.id)?.width ?? DEFAULT_SIZE[node.type].width,
              height: node.height ?? nodeAt(node.id)?.height ?? DEFAULT_SIZE[node.type].height,
            })
            // What the region will hold at a known position: kept nodes as
            // declared over what they were, and new ones that name a spot.
            const occupied = op.nodes.flatMap((node): Rect[] => {
              const existing = nodeAt(node.id)
              const x = node.x ?? existing?.x
              const y = node.y ?? existing?.y
              return x === undefined || y === undefined ? [] : [{ x, y, ...sizeOf(node) }]
            })
            const placements = placeWithin(bounds, needPlacing.map(sizeOf), occupied)
            const placementFor = new Map(
              needPlacing.map((node, at) => [node.id, placements[at]] as const),
            )
            // A placement is this op's own arithmetic, so a placement that
            // lands outside is this op's to fix, not the caller's: the group
            // grows to hold it, gutter included. Only a position the CALLER
            // chose is held to the boundary, below. Growth is grow-only,
            // only on an actual overflow, and keeps the top-left, so
            // re-applying the same region stays a no-op; what it can do is
            // enclose a neighbour that sat just past the old edge, which the
            // NEXT region.set will then see in scope — geometry is geometry,
            // and the result reports the size.
            const needed = needPlacing.reduce(
              (acc, node, at) => {
                const placed = placements[at]
                if (placed === undefined) return acc
                const size = sizeOf(node)
                const right = placed.x + size.width
                const bottom = placed.y + size.height
                return {
                  width:
                    right > bounds.x + bounds.width
                      ? Math.max(acc.width, right + PLACEMENT_GUTTER_PX - bounds.x)
                      : acc.width,
                  height:
                    bottom > bounds.y + bounds.height
                      ? Math.max(acc.height, bottom + PLACEMENT_GUTTER_PX - bounds.y)
                      : acc.height,
                }
              },
              { width: bounds.width, height: bounds.height },
            )
            if (needed.width > bounds.width || needed.height > bounds.height) {
              if (nodeLocks.has(bounds.id)) {
                fail(
                  index,
                  op.op,
                  `"${bounds.id}" is locked and too small for what was placed in it (needs ${needed.width}x${needed.height}); unlock it, or give each node x/y inside it`,
                )
              }
              const grown: SpatialNode = { ...bounds, width: needed.width, height: needed.height }
              nodes = nodes.map((node) => (node.id === grown.id ? grown : node))
              bounds = grown
              touchedNodes.add(grown.id)
              geometry.set(grown.id, {
                id: grown.id,
                x: grown.x,
                y: grown.y,
                width: grown.width,
                height: grown.height,
              })
            }

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
                fail(index, op.op, outsideDetail(declared.id, next, bounds))
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

          case 'comment.add': {
            const draft = op.comment
            const id = draft.id ?? mintId(new Set(comments.map((comment) => comment.id)), 'c')
            if (comments.some((comment) => comment.id === id)) {
              fail(index, op.op, `comment id "${id}" is already on the canvas`)
            }
            let at =
              draft.x !== undefined && draft.y !== undefined
                ? { x: draft.x, y: draft.y }
                : undefined
            if (at === undefined && draft.targetNodeId !== undefined) {
              const target = nodeAt(draft.targetNodeId)
              if (target !== undefined) at = { x: target.x + target.width, y: target.y }
            }
            if (at === undefined) {
              fail(
                index,
                op.op,
                'a comment needs an anchor: give x/y, or a targetNodeId that is on the canvas',
              )
            }
            const parsed = canvasCommentSchema.safeParse({
              ...draft,
              id,
              ...at,
              createdAt: draft.createdAt ?? new Date().toISOString(),
            })
            if (!parsed.success) fail(index, op.op, issues(parsed.error))
            comments = [...comments, parsed.data]
            touchedComments.add(id)
            return
          }

          case 'comment.resolve': {
            if (!comments.some((comment) => comment.id === op.id)) {
              fail(index, op.op, `comment "${op.id}" is not on the canvas`)
            }
            const resolved = op.resolved ?? true
            comments = comments.map((comment) =>
              comment.id === op.id ? { ...comment, resolved } : comment,
            )
            touchedComments.add(op.id)
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

      // The batch writes back the WHOLE canvas, so the canvas-level extension
      // — rendering preferences and every comment the batch did not touch —
      // must ride along, or the save deletes them (writeSpatialCanvas resyncs
      // by omission).
      const { comments: _stored, ...extensionRest } = canvas['x-whiteboard'] ?? {}
      const keptExtension = {
        ...extensionRest,
        ...(comments.length > 0 ? { comments } : {}),
      }
      const hasExtension = Object.values(keptExtension).some((value) => value !== undefined)
      const candidate: SpatialCanvas = hasExtension
        ? { nodes, edges, 'x-whiteboard': keptExtension }
        : { nodes, edges }
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

      // A proposal is stored INSTEAD of the board it describes: the content
      // containers are left exactly as they were, and only the proposals
      // plane grows. Locks are not written either — a lock is a claim on the
      // document, and this batch has not touched the document.
      if (proposing) {
        const proposal = await storeCanvasProposal({
          deps,
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
          doc,
          before: canvas,
          after: parsed.data,
        })
        if (proposal === undefined) {
          throw new CanvasEditError(
            input.ops.length - 1,
            'batch',
            'this batch would change nothing, so there is nothing to propose',
          )
        }
        // Deliberately silent. Nothing changed for a watching browser, so a
        // toast saying "changed 1" would be a lie, and the viewport must not
        // chase an edit nobody made. The editor draws the proposal itself —
        // an outline where each change would land, and a bubble carrying the
        // count — which is the announcement, and it needs no toast.
        return {
          documentId: input.documentId,
          applied: 0,
          touched: {
            nodes: [...touchedNodes].sort(),
            edges: [...touchedEdges].sort(),
            comments: [...touchedComments].sort(),
          },
          geometry: [...geometry.values()].sort((a, b) => a.id.localeCompare(b.id)),
          snapshot: projectCanvasSnapshot(input.documentId, canvas, nodeLocks, edgeLocks),
          proposed: proposal,
        }
      }

      // Locks are written only now, after every op has applied — see the
      // working-copy comment above.
      for (const node of parsed.data.nodes) setNodeLock(doc, node.id, nodeLocks.has(node.id))
      for (const edge of parsed.data.edges) setEdgeLock(doc, edge.id, edgeLocks.has(edge.id))
      await saveDocumentBodySnapshot(deps, input.workspaceId, input.documentId, doc, parsed.data)

      const touched = {
        nodes: [...touchedNodes].sort(),
        edges: [...touchedEdges].sort(),
        comments: [...touchedComments].sort(),
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
