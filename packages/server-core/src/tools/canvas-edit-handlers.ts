import { tidyBoxes, tidyNodes } from '@kamiazya/whiteboard-canvas-render'
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import {
  canvasCommentSchema,
  canvasEdgeSchema,
  canvasLineSchema,
  endIn,
  endNodes,
  nodeText,
  type SpatialNode,
  spatialNodeSchema,
  withNodeText,
} from '@kamiazya/whiteboard-model'
import { fail } from './canvas-edit-error.js'
import { type CanvasEditInput, draftContent, type NodeDraft } from './canvas-edit-ops.js'
import { DEFAULT_SIZE, outsideDetail, overlaps } from './canvas-edit-placement.js'
import {
  assertTextFits,
  type CanvasEditSession,
  fittedHeight,
  mintId,
} from './canvas-edit-session.js'
import { dressWithStencil } from './canvas-edit-stencil.js'
import { publishedKind } from './published-node-kind.js'

/**
 * What one op of a `wb_canvas_edit` batch is applied against: the in-memory
 * canvas every op in the batch shares, plus the registry a stencil resolves
 * through. Deliberately only those two — the case bodies this table replaced
 * closed over `execute`'s whole scope, and reading what they ACTUALLY used
 * found nothing else (`deps`, `doc` and `proposing` were never touched, and
 * every `canvas` match was the word inside a refusal sentence).
 */
export interface CanvasEditContext {
  readonly s: CanvasEditSession
  /**
   * Resolved once per batch, and only when some op NAMES a stencil — finding
   * the workspace library costs a listing plus a read, and the overwhelming
   * majority of batches move boxes and draw lines.
   */
  readonly facetRegistry: FacetRegistry
}

type CanvasOp = CanvasEditInput['ops'][number]
type OpNamed<K extends CanvasOp['op']> = Extract<CanvasOp, { op: K }>

/**
 * One handler per op, keyed by the verb the schema declares.
 *
 * The mapped type is the point: a verb added to `canvasEditInputSchema` and
 * not to this table does not compile, where the switch it replaced would
 * simply fall through and apply nothing — the batch would report success
 * having ignored an op. Each handler also gets its op NARROWED, so
 * `op.patch` on a `node.patch` needs no re-check.
 *
 * Each applies its op to `ctx.s` and returns nothing. Refusal is a throw
 * (`fail`), which is what makes the batch all-or-nothing: no op reaches the
 * document until every one of them has applied.
 */
/**
 * How big a node the caller sized only partly, or not at all, comes out.
 *
 * Each fallback is its own rule, and they were three nested conditionals deep
 * inside the `node.add` handler: a group keeps the flat default rather than
 * the board's width (it is a container, not a column), and a text node's
 * height is MEASURED against the width just decided when a measurer is
 * available — which is why this cannot be a lookup table.
 */
function draftSize(
  ctx: CanvasEditContext,
  draft: NodeDraft,
  id: string,
): { width: number; height: number } {
  const size = DEFAULT_SIZE[draft.type]
  const width =
    draft.width ?? (draft.type === 'group' ? size.width : (ctx.s.boardWidth ?? size.width))
  if (draft.height !== undefined) return { width, height: draft.height }
  if (draft.type !== 'text' || ctx.s.measure === undefined) return { width, height: size.height }
  return {
    width,
    height: fittedHeight(
      { ...draftContent(draft), id, x: 0, y: 0, width, height: size.height },
      ctx.s.measure,
      size.height,
    ),
  }
}

/**
 * The model node a draft becomes, before validation.
 *
 * The published draft carries `type` plus one content field; the model carries
 * a resource. That crossing happens here, at the tool's boundary — see
 * `draftContent` for why the boundary exists at all — and the published names
 * are destructured off so none rides through as an unknown key. `embed` and
 * `facets` ARE the model's own fields on the input, so they travel in `rest`.
 */
function nodeFromDraft(
  draft: NodeDraft,
  id: string,
  at: { x: number; y: number },
  width: number,
  height: number,
): Record<string, unknown> {
  const {
    type: _type,
    text: _text,
    file: _file,
    subpath: _subpath,
    url: _url,
    label: _label,
    background: _background,
    backgroundStyle: _backgroundStyle,
    ...rest
  } = draft as NodeDraft & Record<string, unknown>
  return { ...rest, ...draftContent(draft), id, ...at, width, height }
}

/**
 * A position the CALLER chose, in a group the caller named.
 *
 * Both are explicit, so the group grows until both hold — except before its
 * top-left, which growth cannot reach, so that one is refused.
 */
function holdChosenPosition(
  ctx: CanvasEditContext,
  index: number,
  op: string,
  group: SpatialNode,
  node: SpatialNode,
): void {
  const unplaced = ctx.s.placedByCursor.get(group.id)
  if (unplaced !== undefined) {
    ctx.s.placeAround(index, op, group, [node], unplaced)
    return
  }
  if (node.x < group.x || node.y < group.y) {
    fail(index, op, outsideDetail(node.id, node, group))
  }
  ctx.s.growToHold(index, op, group, [node])
}

/**
 * Everything `region.set` refuses, refused UP FRONT — before anything is
 * removed or moved.
 *
 * This op deletes by OMISSION, and silently dropping a locked element would be
 * the worst possible reading of that. A listed node that is currently
 * elsewhere is about to be moved, so its lock counts too. Written inline, four
 * loops of refusal sat between the scope calculation and the first mutation,
 * and "nothing is refused after something has moved" was a property of where
 * those lines happened to be.
 */
function refuseRegionMembers(
  ctx: CanvasEditContext,
  index: number,
  op: string,
  groupId: string,
  members: ReadonlySet<string>,
  inScope: readonly SpatialNode[],
  inScopeIds: ReadonlySet<string>,
): void {
  if (members.has(groupId)) {
    fail(index, op, `"${groupId}" is the group itself, not one of its members`)
  }
  for (const id of members) {
    if (ctx.s.nodeAt(id) === undefined) {
      fail(
        index,
        op,
        `node "${id}" is not on the canvas; region.set names members that exist — create it with node.add and within "${groupId}"`,
      )
    }
  }
  for (const node of inScope) {
    if (ctx.s.nodeLocks.has(node.id)) {
      fail(index, op, `node "${node.id}" inside the region is locked`)
    }
  }
  for (const id of members) {
    if (!inScopeIds.has(id) && ctx.s.nodeLocks.has(id)) {
      fail(index, op, `node "${id}" is locked; unlock it before moving it into "${groupId}"`)
    }
  }
}

/**
 * Where a drafted node goes: the position the caller gave, a slot inside the
 * group they named, or the next place on the cursor's own walk.
 *
 * Partial geometry is treated as NONE — a node given an x but no y has no
 * position, and guessing the other half would put it somewhere the caller did
 * not ask for either.
 */
function placeDraft(
  ctx: CanvasEditContext,
  index: number,
  op: string,
  draft: NodeDraft,
  within: string | undefined,
  width: number,
  height: number,
): { positioned: boolean; group: SpatialNode | undefined; at: { x: number; y: number } } {
  const positioned = draft.x !== undefined && draft.y !== undefined
  const group = within === undefined ? undefined : ctx.s.groupNamed(index, op, within)
  const at = positioned
    ? { x: draft.x as number, y: draft.y as number }
    : group === undefined
      ? ctx.s.cursor.next(ctx.s.nodes, width, height)
      : ctx.s.placeInside(index, op, group, [{ width, height }])[0]
  if (at === undefined) fail(index, op, 'no placement')
  return { positioned, group, at }
}

/**
 * The arriving half of a membership change: members that are currently
 * elsewhere move in, placed around the ones already inside, and the group
 * grows if it has no room.
 *
 * A member ACROSS the boundary is neither arriving nor settled: that is the
 * mid-drag case the scope rule protects, so it is left exactly where it is.
 */
function bringMembersIn(
  ctx: CanvasEditContext,
  index: number,
  op: string,
  group: SpatialNode,
  listed: readonly string[],
  inScopeIds: ReadonlySet<string>,
): void {
  const arriving = listed.filter((id) => {
    if (inScopeIds.has(id)) return false
    const node = ctx.s.nodeAt(id)
    return node === undefined || !overlaps(node, group)
  })
  const placements = ctx.s.placeInside(
    index,
    op,
    group,
    arriving.map((id) => {
      const node = ctx.s.nodeAt(id)
      return { width: node?.width ?? 0, height: node?.height ?? 0 }
    }),
  )
  arriving.forEach((id, at) => {
    const placed = placements[at]
    const node = ctx.s.nodeAt(id)
    if (placed === undefined || node === undefined) return
    const moved = { ...node, ...placed }
    ctx.s.nodes = ctx.s.nodes.map((candidate) => (candidate.id === id ? moved : candidate))
    ctx.s.touchedNodes.add(id)
    ctx.s.geometry.set(id, { id, ...placed, width: node.width, height: node.height })
  })
}

/**
 * Which edges leave with a membership change.
 *
 * An edge goes if either endpoint just went — a dangling edge stores a canvas
 * the next read refuses — or, when `edges` is given, if it runs between two
 * members and is not listed. A listed edge must exist and must have BOTH ends
 * among the members, which is refused before anything is removed.
 *
 * Scoped to THIS op. `touchedEdges` spans the whole batch, so an edge an
 * earlier op merely touched is not this region's to delete.
 */
function settleRegionEdges(
  ctx: CanvasEditContext,
  index: number,
  op: string,
  members: ReadonlySet<string>,
  listed: readonly string[] | undefined,
  droppedIds: ReadonlySet<string>,
): void {
  const keep = listed === undefined ? undefined : new Set(listed)
  if (keep !== undefined) refuseListedEdges(ctx, index, op, members, keep)
  removeLeavingEdges(ctx, members, keep, droppedIds)
}

/**
 * A listed edge must exist and must have BOTH ends among the members — an
 * edge is in the region only when both ends are. Refused before anything is
 * removed, like every other `region.set` check.
 */
function refuseListedEdges(
  ctx: CanvasEditContext,
  index: number,
  op: string,
  members: ReadonlySet<string>,
  keep: ReadonlySet<string>,
): void {
  for (const id of keep) {
    const edge = ctx.s.edgeAt(id)
    if (edge === undefined) fail(index, op, `edge "${id}" is not on the canvas`)
    for (const endpoint of endNodes(edge)) {
      if (!members.has(endpoint)) {
        fail(
          index,
          op,
          `edge "${id}" ends at "${endpoint}", which is not a member; an edge is in the region only when both ends are`,
        )
      }
    }
  }
}

/** Remove the edges a membership change leaves stranded or unlisted. */
function removeLeavingEdges(
  ctx: CanvasEditContext,
  members: ReadonlySet<string>,
  keep: ReadonlySet<string> | undefined,
  droppedIds: ReadonlySet<string>,
): void {
  const removedEdges = new Set<string>()
  for (const edge of ctx.s.edges) {
    const strandedBy = endIn(edge.from, droppedIds) || endIn(edge.to, droppedIds)
    const unlistedAmongMembers =
      keep !== undefined &&
      endIn(edge.from, members) &&
      endIn(edge.to, members) &&
      !keep.has(edge.id)
    if (strandedBy || unlistedAmongMembers) {
      removedEdges.add(edge.id)
      ctx.s.touchedEdges.add(edge.id)
      ctx.s.edgeLocks.delete(edge.id)
    }
  }
  ctx.s.edges = ctx.s.edges.filter((edge) => !removedEdges.has(edge.id))
}

/**
 * The leaving half of a membership change: what was inside and is not listed
 * goes, because `region.set` deletes by OMISSION.
 *
 * Returns the ids it removed, which is what decides whether an edge is left
 * dangling — see `settleRegionEdges`.
 */
function dropOmittedMembers(
  ctx: CanvasEditContext,
  inScope: readonly SpatialNode[],
  members: ReadonlySet<string>,
): Set<string> {
  const dropped = inScope.filter((node) => !members.has(node.id))
  const droppedIds = new Set(dropped.map((node) => node.id))
  for (const node of dropped) {
    ctx.s.touchedNodes.add(node.id)
    ctx.s.nodeLocks.delete(node.id)
  }
  ctx.s.nodes = ctx.s.nodes.filter((node) => !droppedIds.has(node.id))
  return droppedIds
}

const CANVAS_EDIT_HANDLERS: {
  [K in CanvasOp['op']]: (ctx: CanvasEditContext, op: OpNamed<K>, index: number) => void
} = {
  'node.add': (ctx, op, index) => {
    const draft = op.node
    const id = draft.id ?? mintId(new Set(ctx.s.nodes.map((node) => node.id)), 'n')
    if (ctx.s.nodeAt(id) !== undefined) {
      fail(index, op.op, `node id "${id}" is already on the canvas; patch it or choose another id`)
    }
    const { width, height } = draftSize(ctx, draft, id)
    const { positioned, group, at } = placeDraft(
      ctx,
      index,
      op.op,
      draft,
      op.within ?? undefined,
      width,
      height,
    )

    // `embed` and `facets` are the model's own fields on the input
    // now, so they ride through `rest` rather than being unpacked
    // from a published extension key — see WRITE_EXTENSION.
    const parsed = spatialNodeSchema.safeParse(nodeFromDraft(draft, id, at, width, height))
    if (!parsed.success) fail(index, op.op, ctx.s.issues(parsed.error))
    if (draft.height !== undefined && ctx.s.measure !== undefined) {
      assertTextFits(index, op.op, parsed.data, ctx.s.measure)
    }
    if (positioned && group !== undefined) {
      holdChosenPosition(ctx, index, op.op, group, parsed.data)
    }
    ctx.s.nodes = [
      ...ctx.s.nodes,
      dressWithStencil(index, op.op, parsed.data, op.stencil, draft.color, ctx.facetRegistry),
    ]
    ctx.s.touchedNodes.add(id)
    if (!positioned) ctx.s.geometry.set(id, { id, ...at, width, height })
    if (!positioned && group === undefined && draft.type === 'group') {
      ctx.s.placedByCursor.set(id, { width: draft.width, height: draft.height })
    }
    return
  },
  'node.patch': (ctx, op, index) => {
    const ids = ctx.s.nodeTargets(index, op.op, op)
    // Locks are checked for the whole selection before any of it
    // changes, so a refusal leaves nothing half-applied.
    for (const id of ids) {
      if (ctx.s.nodeLocks.has(id)) {
        fail(index, op.op, `node "${id}" is locked; unlock it with a node.lock op first`)
      }
    }
    for (const id of ids) ctx.s.patchNode(index, op.op, id, op.patch)
    // After the patch, so an explicit `color` in the same op still
    // wins: a caller naming both has said the more specific thing.
    if (op.stencil !== undefined) {
      const stencil = op.stencil
      ctx.s.nodes = ctx.s.nodes.map((node) =>
        ids.includes(node.id)
          ? dressWithStencil(index, op.op, node, stencil, op.patch.color, ctx.facetRegistry)
          : node,
      )
    }
    return
  },
  'node.splice': (ctx, op, index) => {
    const node = ctx.s.nodeAt(op.id)
    if (node === undefined) fail(index, op.op, `node "${op.id}" is not on the canvas`)
    if (ctx.s.nodeLocks.has(op.id)) {
      fail(index, op.op, `node "${op.id}" is locked; unlock it with a node.lock op first`)
    }
    const nodeOwnText = nodeText(node)
    if (nodeOwnText === undefined) {
      fail(
        index,
        op.op,
        `a ${publishedKind(node)} node holds no text to splice; only a text node does`,
      )
    }
    const bodyLines = nodeOwnText.split('\n')
    // Refused rather than clamped: clamping would apply part of the
    // splice and report success, which is the failure the codec's
    // own parsers refuse to degrade into.
    if (op.startLine >= bodyLines.length || op.endLine >= bodyLines.length) {
      fail(
        index,
        op.op,
        `range [${op.startLine}, ${op.endLine}] is out of bounds for a ${bodyLines.length}-line body`,
      )
    }
    const spliced = [
      ...bodyLines.slice(0, op.startLine),
      ...op.replacement.split('\n'),
      ...bodyLines.slice(op.endLine + 1),
    ].join('\n')
    const parsed = spatialNodeSchema.safeParse(withNodeText(node, spliced))
    if (!parsed.success) fail(index, op.op, ctx.s.issues(parsed.error))
    ctx.s.nodes = ctx.s.nodes.map((existing) => (existing.id === op.id ? parsed.data : existing))
    ctx.s.touchedNodes.add(op.id)
    return
  },
  'node.remove': (ctx, op, index) => {
    const ids = new Set(ctx.s.nodeTargets(index, op.op, op))
    for (const id of ids) {
      if (ctx.s.nodeLocks.has(id)) {
        fail(index, op.op, `node "${id}" is locked; unlock it with a node.lock op first`)
      }
    }
    // Edges touching a removed node go with it. Left behind they are
    // a canvas spatialCanvasSchema refuses on the next read, so
    // "apply exactly the op I was handed" would store a board that
    // cannot be loaded.
    for (const edge of ctx.s.edges) {
      if (endIn(edge.from, ids) || endIn(edge.to, ids)) ctx.s.touchedEdges.add(edge.id)
    }
    ctx.s.edges = ctx.s.edges.filter((edge) => !endIn(edge.from, ids) && !endIn(edge.to, ids))
    // Ink ANCHORED to a removed node goes with it for the same
    // reason; ink anchored to nothing stays, because a free end names
    // no node and so cannot dangle (ADR-0038 decision 2).
    for (const line of ctx.s.lines) {
      if (endIn(line.from, ids) || endIn(line.to, ids)) ctx.s.touchedLines.add(line.id)
    }
    ctx.s.lines = ctx.s.lines.filter((line) => !endIn(line.from, ids) && !endIn(line.to, ids))
    ctx.s.nodes = ctx.s.nodes.filter((node) => !ids.has(node.id))
    for (const id of ids) {
      ctx.s.nodeLocks.delete(id)
      ctx.s.touchedNodes.add(id)
    }
    return
  },
  'edge.add': (ctx, op, index) => {
    const draft = op.edge
    const id = draft.id ?? mintId(new Set(ctx.s.edges.map((edge) => edge.id)), 'e')
    if (ctx.s.edgeAt(id) !== undefined) {
      fail(index, op.op, `edge id "${id}" is already on the canvas; patch it or choose another id`)
    }
    // A FREE end names no node, so there is nothing to be missing —
    // the existence check is about a reference, and a point is not one
    // (ADR-0037 slice 3).
    for (const endpoint of endNodes(draft)) {
      if (ctx.s.nodeAt(endpoint) === undefined) {
        fail(index, op.op, `endpoint "${endpoint}" is not on the canvas; add that node first`)
      }
    }
    const parsed = canvasEdgeSchema.safeParse({ ...draft, id })
    if (!parsed.success) fail(index, op.op, ctx.s.issues(parsed.error))
    ctx.s.edges = [...ctx.s.edges, parsed.data]
    ctx.s.touchedEdges.add(id)
    return
  },
  'edge.patch': (ctx, op, index) => {
    const edge = ctx.s.edgeAt(op.id)
    if (edge === undefined) fail(index, op.op, `edge "${op.id}" is not on the canvas`)
    if (ctx.s.edgeLocks.has(op.id)) {
      fail(index, op.op, `edge "${op.id}" is locked; unlock it with an edge.lock op first`)
    }
    const merged = { ...edge, ...op.patch }
    for (const endpoint of endNodes(merged)) {
      if (ctx.s.nodeAt(endpoint) === undefined) {
        fail(index, op.op, `endpoint "${endpoint}" is not on the canvas`)
      }
    }
    const parsed = canvasEdgeSchema.safeParse(merged)
    if (!parsed.success) fail(index, op.op, ctx.s.issues(parsed.error))
    const updated = parsed.data
    ctx.s.edges = ctx.s.edges.map((existing) => (existing.id === op.id ? updated : existing))
    ctx.s.touchedEdges.add(op.id)
    return
  },
  'edge.remove': (ctx, op, index) => {
    const ids = new Set(ctx.s.edgeTargets(index, op.op, op))
    for (const id of ids) {
      if (ctx.s.edgeLocks.has(id)) {
        fail(index, op.op, `edge "${id}" is locked; unlock it with an edge.lock op first`)
      }
    }
    ctx.s.edges = ctx.s.edges.filter((edge) => !ids.has(edge.id))
    for (const id of ids) {
      ctx.s.edgeLocks.delete(id)
      ctx.s.touchedEdges.add(id)
    }
    return
  },
  'line.add': (ctx, op, index) => {
    const draft = op.line
    const id = draft.id ?? mintId(new Set(ctx.s.lines.map((line) => line.id)), 'l')
    if (ctx.s.lineAt(id) !== undefined) {
      fail(index, op.op, `line id "${id}" is already on the canvas; patch it or choose another id`)
    }
    for (const endpoint of endNodes(draft)) {
      if (ctx.s.nodeAt(endpoint) === undefined) {
        fail(index, op.op, `endpoint "${endpoint}" is not on the canvas; add that node first`)
      }
    }
    const parsed = canvasLineSchema.safeParse({ ...draft, id })
    if (!parsed.success) fail(index, op.op, ctx.s.issues(parsed.error))
    ctx.s.lines = [...ctx.s.lines, parsed.data]
    ctx.s.touchedLines.add(id)
    return
  },
  'line.patch': (ctx, op, index) => {
    const line = ctx.s.lineAt(op.id)
    if (line === undefined) fail(index, op.op, `line "${op.id}" is not on the canvas`)
    const merged = { ...line, ...op.patch }
    for (const endpoint of endNodes(merged)) {
      if (ctx.s.nodeAt(endpoint) === undefined) {
        fail(index, op.op, `endpoint "${endpoint}" is not on the canvas`)
      }
    }
    const parsed = canvasLineSchema.safeParse(merged)
    if (!parsed.success) fail(index, op.op, ctx.s.issues(parsed.error))
    ctx.s.lines = ctx.s.lines.map((existing) => (existing.id === op.id ? parsed.data : existing))
    ctx.s.touchedLines.add(op.id)
    return
  },
  'line.remove': (ctx, op, index) => {
    if (ctx.s.lineAt(op.id) === undefined) {
      fail(index, op.op, `line "${op.id}" is not on the canvas`)
    }
    ctx.s.lines = ctx.s.lines.filter((line) => line.id !== op.id)
    ctx.s.touchedLines.add(op.id)
    return
  },
  'node.lock': (ctx, op, index) => {
    for (const id of ctx.s.nodeTargets(index, op.op, op)) {
      if (op.locked) ctx.s.nodeLocks.add(id)
      else ctx.s.nodeLocks.delete(id)
      ctx.s.touchedNodes.add(id)
    }
    return
  },
  'edge.lock': (ctx, op, index) => {
    for (const id of ctx.s.edgeTargets(index, op.op, op)) {
      if (op.locked) ctx.s.edgeLocks.add(id)
      else ctx.s.edgeLocks.delete(id)
      ctx.s.touchedEdges.add(id)
    }
    return
  },
  'region.set': (ctx, op, index) => {
    let group = ctx.s.groupNamed(index, op.op, op.within)
    // A group this batch put at the cursor and never placed around
    // anything holds nothing, whatever the cursor's box covers.
    const unsettled =
      ctx.s.placedByCursor.get(group.id)?.placed !== true && ctx.s.placedByCursor.has(group.id)
    const inScope = unsettled ? [] : ctx.s.nodes.filter(ctx.s.enclosedBy(group))
    const inScopeIds = new Set(inScope.map((node) => node.id))
    const members = new Set(op.nodes)
    refuseRegionMembers(ctx, index, op.op, group.id, members, inScope, inScopeIds)

    // A group this batch placed at the cursor, still holding nothing,
    // goes around its members where they sit: their bounds plus the
    // gutter, never smaller than a size it was given. A bystander in
    // that box would become a member the next region.set deletes by
    // omission, so it is a wall; a frame the box nests inside is not.
    const unplaced = ctx.s.placedByCursor.get(group.id)
    if (unplaced !== undefined && unsettled && members.size > 0) {
      const rects = [...members].map((id) => ctx.s.nodeAt(id) as SpatialNode)
      group = ctx.s.placeAround(index, op.op, group, rects, unplaced)
    }

    const droppedIds = dropOmittedMembers(ctx, inScope, members)

    // Members that are elsewhere come in, placed around the ones
    // already inside; the group grows if it has no room. A member
    // ACROSS the boundary is neither: that is the mid-drag case the
    // scope rule protects, so it is left exactly where it is.
    bringMembersIn(ctx, index, op.op, group, op.nodes, inScopeIds)

    settleRegionEdges(ctx, index, op.op, members, op.edges, droppedIds)
    return
  },
  'comment.add': (ctx, op, index) => {
    const draft = op.comment
    const id = draft.id ?? mintId(new Set(ctx.s.comments.map((comment) => comment.id)), 'c')
    if (ctx.s.comments.some((comment) => comment.id === id)) {
      fail(index, op.op, `comment id "${id}" is already on the canvas`)
    }
    let at = draft.x !== undefined && draft.y !== undefined ? { x: draft.x, y: draft.y } : undefined
    if (at === undefined && draft.targetNodeId !== undefined) {
      const target = ctx.s.nodeAt(draft.targetNodeId)
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
    if (!parsed.success) fail(index, op.op, ctx.s.issues(parsed.error))
    ctx.s.comments = [...ctx.s.comments, parsed.data]
    ctx.s.touchedComments.add(id)
    return
  },
  'comment.resolve': (ctx, op, index) => {
    if (!ctx.s.comments.some((comment) => comment.id === op.id)) {
      fail(index, op.op, `comment "${op.id}" is not on the canvas`)
    }
    const resolved = op.resolved ?? true
    ctx.s.comments = ctx.s.comments.map((comment) =>
      comment.id === op.id ? { ...comment, resolved } : comment,
    )
    ctx.s.touchedComments.add(op.id)
    return
  },
  tidy: (ctx, op, index) => {
    // Locks bind tidy exactly as they bind the editor: a locked node
    // is a fixed obstacle it routes around, never one it moves.
    const scope =
      op.within !== undefined ? ctx.s.nodeTargets(index, op.op, { within: op.within }) : op.scope
    const moved = tidyNodes(tidyBoxes(ctx.s.nodes), {
      scope: scope === undefined ? undefined : new Set(scope),
      locked: (id) => ctx.s.nodeLocks.has(id),
      edges: ctx.s.edges,
    })
    const target = new Map(moved.map((move) => [move.id, move]))
    ctx.s.nodes = ctx.s.nodes.map((node) => {
      const move = target.get(node.id)
      if (move === undefined) return node
      // A frame that grew to hold its members carries its new size.
      const size = {
        width: move.width ?? node.width,
        height: move.height ?? node.height,
      }
      ctx.s.geometry.set(node.id, { id: node.id, x: move.x, y: move.y, ...size })
      ctx.s.touchedNodes.add(node.id)
      return { ...node, x: move.x, y: move.y, ...size }
    })
    return
  },
}

/**
 * Applies one op through the table.
 *
 * The cast is the one place this design costs anything, and it is a known
 * TypeScript limitation rather than a hole: the compiler will not correlate
 * `op.op` with `HANDLERS[op.op]` across a union, so the looked-up handler's
 * parameter type collapses to the INTERSECTION of every arm and no union
 * member satisfies it. What the table buys in exchange — a verb that cannot
 * be added without a handler — is checked above, where it matters.
 */
export function applyCanvasOp(ctx: CanvasEditContext, op: CanvasOp, index: number): void {
  const handle = CANVAS_EDIT_HANDLERS[op.op] as (
    ctx: CanvasEditContext,
    op: CanvasOp,
    index: number,
  ) => void
  handle(ctx, op, index)
}
