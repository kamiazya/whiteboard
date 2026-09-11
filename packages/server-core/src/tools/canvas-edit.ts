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
  type CanvasComment,
  type CanvasEdge,
  canvasCommentSchema,
  canvasEdgeSchema,
  type nodePatchFieldsSchema,
  type SpatialCanvas,
  type SpatialNode,
  spatialCanvasSchema,
  spatialNodeSchema,
} from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import type { z } from 'zod'
import { MCP_SCENE_APPEARANCE } from '../render/compose-canvas-scene.js'
import { resolveTextMeasurer } from '../render/text-measurer.js'
import type { CanvasOpSummaryInput, ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { CanvasEditError } from './canvas-edit-error.js'
import {
  type CanvasEditInput,
  type CanvasEditOutput,
  canvasEditInputSchema,
  canvasEditOutputSchema,
  type geometryEntrySchema,
  type Target,
} from './canvas-edit-ops.js'
import {
  DEFAULT_SIZE,
  outsideDetail,
  overlaps,
  PLACEMENT_GUTTER_PX,
  PlacementCursor,
  placeWithin,
  type Rect,
} from './canvas-edit-placement.js'
import { dressWithStencil } from './canvas-edit-stencil.js'
import { isProposableOp, storeCanvasProposal } from './canvas-propose.js'
import { projectCanvasSnapshot } from './canvas-snapshot.js'
import { loadDocument, saveDocumentBodySnapshot } from './document-io.js'
import { DocumentKindMismatchError } from './errors.js'
import { workspaceFacetRegistry } from './stencil-library.js'

export { canvasEditInputSchema } from './canvas-edit-ops.js'
export { PLACEMENT_COLUMNS, PLACEMENT_GUTTER_PX } from './canvas-edit-placement.js'

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
  // The taller of two readings: the composition root's own font, and the
  // ratio measurer every machine has. The daemon's font is narrower than
  // the ratio, so a box it fits can still read as cut to the drawing score
  // and to a client drawing with a wider font; the floor is what makes
  // "fits" mean the same thing to the tool and to what judges it.
  const under = (m: MeasureText) =>
    naturalNodeContentSize(node, { measure: m, appearance: MCP_SCENE_APPEARANCE }).h
  const natural = Math.max(under(measure), under(constantRatioMeasureText))
  return Math.max(fallback, natural + 2 * SPATIAL_THEME_GEOMETRY.paddingPx)
}

/**
 * Refuses a text node whose named height cannot hold its text at its width,
 * naming the height it needs. A named height used to be kept however small
 * — "no height" and "a small height" are different inputs — until the lane
 * read what a model does with that: it names its neighbours' size to match
 * them and the sentence is cut where nothing it can see says so. Growing
 * the box silently would put it into whatever sits below, so the number
 * goes back to the caller instead.
 */
function assertTextFits(index: number, opName: string, node: SpatialNode, measure: MeasureText) {
  if (node.type !== 'text') return
  // Whole pixels, as JSON Canvas sizes are; a box short by a fraction of one
  // is a box the renderer draws without a fade.
  const needs = Math.floor(fittedHeight(node, measure, 0))
  if (node.height < needs) {
    fail(
      index,
      opName,
      `its text needs ${needs}px of height at width ${node.width}; name at least that, or omit height and the box is sized to fit`,
    )
  }
}

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
      // The deployment's registry PLUS this workspace's own stencil library,
      // which is a document in it (ADR-0034 decision 4). Two scopes: a
      // plugin set is chosen once per server because facet schemas are fixed
      // at distribution time, and a library is content that belongs to the
      // workspace holding it. A workspace with no library gets the base
      // registry back unchanged, same instance.
      //
      // Resolved only for a batch that NAMES a stencil. Finding the library
      // costs a document listing plus a read, and this is the hottest write
      // tool there is — the overwhelming majority of batches move boxes and
      // draw lines, and none of them should pay for a vocabulary they do not
      // mention. `facetRegistry` is used for stencils and nothing else here,
      // which is what makes that safe rather than clever.
      const namesAStencil = input.ops.some(
        (op) => 'stencil' in op && (op as { stencil?: string }).stencil !== undefined,
      )
      const facetRegistry = namesAStencil
        ? await workspaceFacetRegistry(deps, input.workspaceId)
        : (deps.facetRegistry ?? bundledFacetRegistry)
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
      /**
       * Groups this batch put at the cursor, with the sizes they were given
       * (a default is not a choice). A caller that adds a group with no
       * position and then declares its members has said where the group
       * goes: around them. Placing it at the cursor and pulling the members
       * in put a row the caller had just drawn into a column inside a
       * default box, and every model then spent two calls undoing it.
       */
      const placedByCursor = new Map<string, { width?: number; height?: number; placed?: true }>()

      // Resolved once, and only when some op creates a text node or changes
      // what decides whether one's text fits — the composition root's
      // measurer parses a font on first use, and a batch of moves and locks
      // should not pay for that. `region.set` is deliberately NOT included:
      // what it declares must fit inside its group, so growing a node there
      // could refuse the very op that asked for it. A node created there
      // keeps the flat default.
      const wantsFit = input.ops.some(
        (op) =>
          (op.op === 'node.add' && op.node.type === 'text') ||
          (op.op === 'node.patch' &&
            (op.patch.text !== undefined ||
              op.patch.width !== undefined ||
              op.patch.height !== undefined)),
      )
      const measure: MeasureText | undefined = wantsFit
        ? (await resolveTextMeasurer(deps)).measure
        : undefined

      const nodeAt = (id: string) => nodes.find((node) => node.id === id)
      const edgeAt = (id: string) => edges.find((edge) => edge.id === id)

      const groupNamed = (index: number, opName: string, id: string): SpatialNode => {
        const group = nodeAt(id)
        if (group === undefined || group.type !== 'group') {
          fail(
            index,
            opName,
            `"${id}" is not a group on the canvas; within names one to place inside — to wrap boxes that already exist in a new group, add the group and then region.set`,
          )
        }
        return group
      }
      /** Strict containment in a group's CURRENT box, the group itself excluded. */
      const enclosedBy =
        (group: SpatialNode) =>
        (node: SpatialNode): boolean =>
          node.id !== group.id &&
          node.x >= group.x &&
          node.y >= group.y &&
          node.x + node.width <= group.x + group.width &&
          node.y + node.height <= group.y + group.height
      /**
       * Grows a group so that every rect is inside it, gutter included.
       * Grow-only, only when a rect reaches past the right or bottom edge
       * less `keep` (a caller's own position is honoured to the edge; a
       * position this batch chose keeps the gutter, since flush with the
       * frame reads as jammed), and the top-left stays put, so re-applying
       * the same op stays a no-op; what it can do is enclose a neighbour
       * that sat just past the old edge, which the next region.set will
       * then see in scope — geometry is geometry, and the result reports
       * the size. A rect before the top-left is the caller's to move;
       * callers refuse it.
       */
      const growToHold = (
        index: number,
        opName: string,
        group: SpatialNode,
        rects: readonly Rect[],
        keep = 0,
      ): void => {
        const bounds = nodeAt(group.id) ?? group
        const needed = rects.reduce(
          (acc, rect) => {
            const right = rect.x + rect.width
            const bottom = rect.y + rect.height
            return {
              width:
                right + keep > bounds.x + bounds.width
                  ? Math.max(acc.width, right + PLACEMENT_GUTTER_PX - bounds.x)
                  : acc.width,
              height:
                bottom + keep > bounds.y + bounds.height
                  ? Math.max(acc.height, bottom + PLACEMENT_GUTTER_PX - bounds.y)
                  : acc.height,
            }
          },
          { width: bounds.width, height: bounds.height },
        )
        if (needed.width <= bounds.width && needed.height <= bounds.height) return
        // Never over a neighbour. Growth that swallows a node just past the
        // old edge makes it a member the next region.set deletes by
        // omission — so a node the old box did not overlap is a wall, and
        // the refusal names it.
        const grownBox = { ...bounds, width: needed.width, height: needed.height }
        const wall = nodes.find(
          (node) => node.id !== bounds.id && !overlaps(node, bounds) && overlaps(node, grownBox),
        )
        if (wall !== undefined) {
          fail(
            index,
            opName,
            `"${bounds.id}" would have to grow to ${needed.width}x${needed.height} and that reaches "${wall.id}"; move "${wall.id}" or place the node elsewhere`,
          )
        }
        if (nodeLocks.has(bounds.id)) {
          fail(
            index,
            opName,
            `"${bounds.id}" is locked and too small for what goes in it (needs ${needed.width}x${needed.height}); unlock it, or keep each node inside it`,
          )
        }
        const grown: SpatialNode = { ...bounds, width: needed.width, height: needed.height }
        nodes = nodes.map((node) => (node.id === grown.id ? grown : node))
        touchedNodes.add(grown.id)
        geometry.set(grown.id, {
          id: grown.id,
          x: grown.x,
          y: grown.y,
          width: grown.width,
          height: grown.height,
        })
      }
      /**
       * Places sizes inside a group around what it already holds. A
       * placement is this batch's own arithmetic, so a placement that lands
       * outside is its to fix, not the caller's: the group grows.
       */
      const placeInside = (
        index: number,
        opName: string,
        group: SpatialNode,
        sizes: readonly { width: number; height: number }[],
      ): { x: number; y: number }[] => {
        const bounds = nodeAt(group.id) ?? group
        const placements = placeWithin(bounds, sizes, nodes.filter(enclosedBy(bounds)))
        growToHold(
          index,
          opName,
          bounds,
          placements.map((at, i) => ({ ...at, ...(sizes[i] ?? { width: 0, height: 0 }) })),
          PLACEMENT_GUTTER_PX,
        )
        return placements
      }

      /**
       * Puts a group this batch placed at the cursor around what is put in
       * it: the rects' bounds plus the gutter, joined with the group's
       * current box when it already holds something, never smaller than a
       * size it was given. A bystander in that box would become a member
       * the next region.set deletes by omission, so it is a wall; a frame
       * the box nests inside is not.
       */
      const placeAround = (
        index: number,
        opName: string,
        group: SpatialNode,
        rects: readonly SpatialNode[],
        given: { width?: number; height?: number; placed?: true },
      ): SpatialNode => {
        // The cursor's box holds nothing, whatever it happens to cover: only
        // a box already placed around members is joined with the next.
        const holding = given.placed === true
        const around = rects.map((r) => ({
          x: r.x - PLACEMENT_GUTTER_PX,
          y: r.y - PLACEMENT_GUTTER_PX,
          width: r.width + 2 * PLACEMENT_GUTTER_PX,
          height: r.height + 2 * PLACEMENT_GUTTER_PX,
        }))
        const all = holding ? [...around, group] : around
        const left = Math.min(...all.map((r) => r.x))
        const top = Math.min(...all.map((r) => r.y))
        const right = Math.max(...all.map((r) => r.x + r.width))
        const bottom = Math.max(...all.map((r) => r.y + r.height))
        const box = {
          x: left,
          y: top,
          width: Math.max(given.width ?? 0, right - left),
          height: Math.max(given.height ?? 0, bottom - top),
        }
        const members = new Set(rects.map((r) => r.id))
        // Another group this batch put at the cursor, still holding
        // nothing, is not a wall: it follows its own members when they
        // come, and until then the cursor's spot is nobody's choice.
        const unsettled = (node: SpatialNode) =>
          placedByCursor.has(node.id) && placedByCursor.get(node.id)?.placed !== true
        const wall = nodes.find(
          (node) =>
            node.id !== group.id &&
            !members.has(node.id) &&
            !enclosedBy(group)(node) &&
            !unsettled(node) &&
            overlaps(node, box) &&
            !(node.type === 'group' && enclosedBy(node)({ ...group, ...box })),
        )
        if (wall !== undefined) {
          fail(
            index,
            opName,
            `"${group.id}" placed around its members would reach "${wall.id}"; move "${wall.id}", or give "${group.id}" a position and size`,
          )
        }
        const placed = { ...group, ...box }
        nodes = nodes.map((node) => (node.id === group.id ? placed : node))
        touchedNodes.add(group.id)
        geometry.set(group.id, { id: group.id, ...box })
        placedByCursor.set(group.id, { ...given, placed: true })
        return placed
      }

      /** The node ids one target selects, in canvas order; never empty. */
      const nodeTargets = (index: number, opName: string, target: Target): string[] => {
        if (target.id !== undefined) {
          if (nodeAt(target.id) === undefined) {
            fail(index, opName, `node "${target.id}" is not on the canvas`)
          }
          return [target.id]
        }
        if (target.within !== undefined) {
          const group = groupNamed(index, opName, target.within)
          const ids = nodes.filter(enclosedBy(group)).map((node) => node.id)
          if (ids.length === 0) fail(index, opName, `no node is inside "${group.id}"`)
          return ids
        }
        if (nodes.length === 0) fail(index, opName, 'the canvas has no nodes')
        return nodes.map((node) => node.id)
      }
      const edgeTargets = (index: number, opName: string, target: Target): string[] => {
        if (target.id !== undefined) {
          if (edgeAt(target.id) === undefined) {
            fail(index, opName, `edge "${target.id}" is not on the canvas`)
          }
          return [target.id]
        }
        if (target.within !== undefined) {
          const group = groupNamed(index, opName, target.within)
          const inside = new Set(nodes.filter(enclosedBy(group)).map((node) => node.id))
          const ids = edges
            .filter((edge) => inside.has(edge.fromNode) && inside.has(edge.toNode))
            .map((edge) => edge.id)
          if (ids.length === 0) fail(index, opName, `no edge has both ends inside "${group.id}"`)
          return ids
        }
        if (edges.length === 0) fail(index, opName, 'the canvas has no edges')
        return edges.map((edge) => edge.id)
      }

      const issues = (error: z.ZodError): string =>
        error.issues.map((issue) => issue.message).join('; ')
      const patchNode = (
        index: number,
        opName: string,
        id: string,
        patch: z.infer<typeof nodePatchFieldsSchema>,
      ): void => {
        const node = nodeAt(id)
        if (node === undefined) fail(index, opName, `node "${id}" is not on the canvas`)
        const parsed = spatialNodeSchema.safeParse({ ...node, ...patch })
        if (!parsed.success) fail(index, opName, issues(parsed.error))
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
        const dropped = Object.keys(patch).filter((key) => !(key in updated))
        if (dropped.length > 0) {
          fail(
            index,
            opName,
            `a ${updated.type} node has no ${dropped.join(', ')} — the patch would have been ` +
              'accepted and silently dropped, so it is refused instead',
          )
        }
        if (
          measure !== undefined &&
          (patch.text !== undefined || patch.width !== undefined || patch.height !== undefined)
        ) {
          assertTextFits(index, opName, updated, measure)
        }
        nodes = nodes.map((existing) => (existing.id === id ? updated : existing))
        touchedNodes.add(id)
      }

      input.ops.forEach((op, index) => {
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
            const within = op.within ?? undefined
            const group = within === undefined ? undefined : groupNamed(index, op.op, within)
            const at = positioned
              ? { x: draft.x as number, y: draft.y as number }
              : group === undefined
                ? cursor.next(nodes, width, height)
                : placeInside(index, op.op, group, [{ width, height }])[0]
            if (at === undefined) fail(index, op.op, 'no placement')

            const parsed = spatialNodeSchema.safeParse({ ...draft, id, ...at, width, height })
            if (!parsed.success) fail(index, op.op, issues(parsed.error))
            if (draft.height !== undefined && measure !== undefined) {
              assertTextFits(index, op.op, parsed.data, measure)
            }
            // A position the CALLER chose, in a group the caller named: both
            // are explicit, and the group grows so both hold — except before
            // its top-left, which growth keeps, so that one is refused.
            if (positioned && group !== undefined) {
              const unplaced = placedByCursor.get(group.id)
              if (unplaced !== undefined) {
                placeAround(index, op.op, group, [parsed.data], unplaced)
              } else {
                if (parsed.data.x < group.x || parsed.data.y < group.y) {
                  fail(index, op.op, outsideDetail(id, parsed.data, group))
                }
                growToHold(index, op.op, group, [parsed.data])
              }
            }
            nodes = [
              ...nodes,
              dressWithStencil(index, op.op, parsed.data, op.stencil, draft.color, facetRegistry),
            ]
            touchedNodes.add(id)
            if (!positioned) geometry.set(id, { id, ...at, width, height })
            if (!positioned && group === undefined && draft.type === 'group') {
              placedByCursor.set(id, { width: draft.width, height: draft.height })
            }
            return
          }

          case 'node.patch': {
            const ids = nodeTargets(index, op.op, op)
            // Locks are checked for the whole selection before any of it
            // changes, so a refusal leaves nothing half-applied.
            for (const id of ids) {
              if (nodeLocks.has(id)) {
                fail(index, op.op, `node "${id}" is locked; unlock it with a node.lock op first`)
              }
            }
            for (const id of ids) patchNode(index, op.op, id, op.patch)
            // After the patch, so an explicit `color` in the same op still
            // wins: a caller naming both has said the more specific thing.
            if (op.stencil !== undefined) {
              const stencil = op.stencil
              nodes = nodes.map((node) =>
                ids.includes(node.id)
                  ? dressWithStencil(index, op.op, node, stencil, op.patch.color, facetRegistry)
                  : node,
              )
            }
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
            const ids = new Set(nodeTargets(index, op.op, op))
            for (const id of ids) {
              if (nodeLocks.has(id)) {
                fail(index, op.op, `node "${id}" is locked; unlock it with a node.lock op first`)
              }
            }
            // Edges touching a removed node go with it. Left behind they are
            // a canvas spatialCanvasSchema refuses on the next read, so
            // "apply exactly the op I was handed" would store a board that
            // cannot be loaded.
            for (const edge of edges) {
              if (ids.has(edge.fromNode) || ids.has(edge.toNode)) touchedEdges.add(edge.id)
            }
            edges = edges.filter((edge) => !ids.has(edge.fromNode) && !ids.has(edge.toNode))
            nodes = nodes.filter((node) => !ids.has(node.id))
            for (const id of ids) {
              nodeLocks.delete(id)
              touchedNodes.add(id)
            }
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
            const ids = new Set(edgeTargets(index, op.op, op))
            for (const id of ids) {
              if (edgeLocks.has(id)) {
                fail(index, op.op, `edge "${id}" is locked; unlock it with an edge.lock op first`)
              }
            }
            edges = edges.filter((edge) => !ids.has(edge.id))
            for (const id of ids) {
              edgeLocks.delete(id)
              touchedEdges.add(id)
            }
            return
          }

          case 'node.lock':
            for (const id of nodeTargets(index, op.op, op)) {
              if (op.locked) nodeLocks.add(id)
              else nodeLocks.delete(id)
              touchedNodes.add(id)
            }
            return

          case 'edge.lock':
            for (const id of edgeTargets(index, op.op, op)) {
              if (op.locked) edgeLocks.add(id)
              else edgeLocks.delete(id)
              touchedEdges.add(id)
            }
            return

          case 'region.set': {
            let group = groupNamed(index, op.op, op.within)
            // A group this batch put at the cursor and never placed around
            // anything holds nothing, whatever the cursor's box covers.
            const unsettled =
              placedByCursor.get(group.id)?.placed !== true && placedByCursor.has(group.id)
            const inScope = unsettled ? [] : nodes.filter(enclosedBy(group))
            const inScopeIds = new Set(inScope.map((node) => node.id))
            const members = new Set(op.nodes)
            if (members.has(group.id)) {
              fail(index, op.op, `"${group.id}" is the group itself, not one of its members`)
            }
            for (const id of members) {
              if (nodeAt(id) === undefined) {
                fail(
                  index,
                  op.op,
                  `node "${id}" is not on the canvas; region.set names members that exist — create it with node.add and within "${group.id}"`,
                )
              }
            }
            // Refused up front, before anything is removed or moved: this op
            // deletes by OMISSION, and silently dropping a locked element
            // would be the worst possible reading of that. A listed node
            // that is elsewhere is about to be moved, so its lock counts too.
            for (const node of inScope) {
              if (nodeLocks.has(node.id)) {
                fail(index, op.op, `node "${node.id}" inside the region is locked`)
              }
            }
            for (const id of members) {
              if (!inScopeIds.has(id) && nodeLocks.has(id)) {
                fail(
                  index,
                  op.op,
                  `node "${id}" is locked; unlock it before moving it into "${group.id}"`,
                )
              }
            }

            // A group this batch placed at the cursor, still holding nothing,
            // goes around its members where they sit: their bounds plus the
            // gutter, never smaller than a size it was given. A bystander in
            // that box would become a member the next region.set deletes by
            // omission, so it is a wall; a frame the box nests inside is not.
            const unplaced = placedByCursor.get(group.id)
            if (unplaced !== undefined && unsettled && members.size > 0) {
              const rects = [...members].map((id) => nodeAt(id) as SpatialNode)
              group = placeAround(index, op.op, group, rects, unplaced)
            }

            const dropped = inScope.filter((node) => !members.has(node.id))
            const droppedIds = new Set(dropped.map((node) => node.id))
            for (const node of dropped) {
              touchedNodes.add(node.id)
              nodeLocks.delete(node.id)
            }
            nodes = nodes.filter((node) => !droppedIds.has(node.id))

            // Members that are elsewhere come in, placed around the ones
            // already inside; the group grows if it has no room. A member
            // ACROSS the boundary is neither: that is the mid-drag case the
            // scope rule protects, so it is left exactly where it is.
            const arriving = op.nodes.filter((id) => {
              if (inScopeIds.has(id)) return false
              const node = nodeAt(id)
              return node === undefined || !overlaps(node, group)
            })
            const placements = placeInside(
              index,
              op.op,
              group,
              arriving.map((id) => {
                const node = nodeAt(id)
                return { width: node?.width ?? 0, height: node?.height ?? 0 }
              }),
            )
            arriving.forEach((id, at) => {
              const placed = placements[at]
              const node = nodeAt(id)
              if (placed === undefined || node === undefined) return
              const moved = { ...node, ...placed }
              nodes = nodes.map((candidate) => (candidate.id === id ? moved : candidate))
              touchedNodes.add(id)
              geometry.set(id, { id, ...placed, width: node.width, height: node.height })
            })

            // An edge goes if either endpoint just went — a dangling edge
            // stores a canvas the next read refuses — or, when `edges` is
            // given, if it runs between two members and is not listed.
            // Scoped to THIS op. `touchedEdges` spans the whole batch, so an
            // edge an earlier op merely touched is not this region's to
            // delete.
            const keep = op.edges === undefined ? undefined : new Set(op.edges)
            if (keep !== undefined) {
              for (const id of keep) {
                const edge = edgeAt(id)
                if (edge === undefined) fail(index, op.op, `edge "${id}" is not on the canvas`)
                for (const endpoint of [edge.fromNode, edge.toNode]) {
                  if (!members.has(endpoint)) {
                    fail(
                      index,
                      op.op,
                      `edge "${id}" ends at "${endpoint}", which is not a member; an edge is in the region only when both ends are`,
                    )
                  }
                }
              }
            }
            const removedEdges = new Set<string>()
            for (const edge of edges) {
              const strandedBy = droppedIds.has(edge.fromNode) || droppedIds.has(edge.toNode)
              const unlistedAmongMembers =
                keep !== undefined &&
                members.has(edge.fromNode) &&
                members.has(edge.toNode) &&
                !keep.has(edge.id)
              if (strandedBy || unlistedAmongMembers) {
                removedEdges.add(edge.id)
                touchedEdges.add(edge.id)
                edgeLocks.delete(edge.id)
              }
            }
            edges = edges.filter((edge) => !removedEdges.has(edge.id))
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
            const scope =
              op.within !== undefined ? nodeTargets(index, op.op, { within: op.within }) : op.scope
            const moved = tidyNodes(nodes, {
              scope: scope === undefined ? undefined : new Set(scope),
              locked: (id) => nodeLocks.has(id),
              edges,
            })
            const target = new Map(moved.map((move) => [move.id, move]))
            nodes = nodes.map((node) => {
              const move = target.get(node.id)
              if (move === undefined) return node
              // A frame that grew to hold its members carries its new size.
              const size = {
                width: move.width ?? node.width,
                height: move.height ?? node.height,
              }
              geometry.set(node.id, { id: node.id, x: move.x, y: move.y, ...size })
              touchedNodes.add(node.id)
              return { ...node, x: move.x, y: move.y, ...size }
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
