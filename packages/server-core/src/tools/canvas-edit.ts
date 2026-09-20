import { type MeasureText, tidyBoxes, tidyNodes } from '@kamiazya/whiteboard-canvas-render'
import {
  readDocumentKind,
  setEdgeLock,
  setNodeLock,
  writeDocumentKind,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  canvasCommentSchema,
  canvasEdgeSchema,
  canvasLineSchema,
  endIn,
  endNodes,
  nodeText,
  type SpatialCanvas,
  type SpatialNode,
  spatialCanvasSchema,
  spatialNodeSchema,
  withNodeText,
} from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { resolveTextMeasurer } from '../render/text-measurer.js'
import type { CanvasOpSummaryInput, ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { CanvasEditError, fail } from './canvas-edit-error.js'
import {
  type CanvasEditInput,
  type CanvasEditOutput,
  canvasEditInputSchema,
  canvasEditOutputSchema,
  draftContent,
  type NodeDraft,
} from './canvas-edit-ops.js'
import { DEFAULT_SIZE, outsideDetail, overlaps } from './canvas-edit-placement.js'
import { assertTextFits, CanvasEditSession, fittedHeight } from './canvas-edit-session.js'
import { dressWithStencil } from './canvas-edit-stencil.js'
import { isProposableOp, storeCanvasProposal } from './canvas-propose.js'
import { projectCanvasSnapshot } from './canvas-snapshot.js'
import { loadDocument, saveDocumentBodySnapshot } from './document-io.js'
import { DocumentKindMismatchError } from './errors.js'
import { publishedKind } from './published-node-kind.js'
import { workspaceFacetRegistry } from './stencil-library.js'

export { canvasEditInputSchema } from './canvas-edit-ops.js'
export { PLACEMENT_COLUMNS, PLACEMENT_GUTTER_PX } from './canvas-edit-placement.js'

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
    if (op.op === 'node.add' || op.op === 'edge.add' || op.op === 'line.add') counts.added += 1
    else if (op.op === 'node.patch' || op.op === 'edge.patch' || op.op === 'line.patch')
      counts.changed += 1
    else if (op.op === 'comment.add') counts.commented += 1
    else if (op.op === 'comment.resolve') resolvedComments += 1
    else if (op.op === 'node.remove' || op.op === 'edge.remove' || op.op === 'line.remove')
      counts.removed += 1
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
        ? await workspaceFacetRegistry(deps, input.workspaceId, 'deployment')
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

      // Every op runs against this session; nothing reaches the doc until
      // the last op has applied. That is what makes the batch all-or-nothing
      // — including the lock ops, which would otherwise write through to the
      // doc's sidecar map as they were applied.
      const s = new CanvasEditSession(canvas, doc, measure)

      input.ops.forEach((op, index) => {
        switch (op.op) {
          case 'node.add': {
            const draft = op.node
            const id = draft.id ?? mintId(new Set(s.nodes.map((node) => node.id)), 'n')
            if (s.nodeAt(id) !== undefined) {
              fail(
                index,
                op.op,
                `node id "${id}" is already on the canvas; patch it or choose another id`,
              )
            }
            const size = DEFAULT_SIZE[draft.type]
            const width =
              draft.width ?? (draft.type === 'group' ? size.width : (s.boardWidth ?? size.width))
            const height =
              draft.height ??
              (draft.type === 'text' && measure !== undefined
                ? fittedHeight(
                    { ...draftContent(draft), id, x: 0, y: 0, width, height: size.height },
                    measure,
                    size.height,
                  )
                : size.height)
            // Partial geometry is treated as none: a node given an x but no
            // y has no position, and guessing the other half would put it
            // somewhere the caller did not ask for either.
            const positioned = draft.x !== undefined && draft.y !== undefined
            const within = op.within ?? undefined
            const group = within === undefined ? undefined : s.groupNamed(index, op.op, within)
            const at = positioned
              ? { x: draft.x as number, y: draft.y as number }
              : group === undefined
                ? s.cursor.next(s.nodes, width, height)
                : s.placeInside(index, op.op, group, [{ width, height }])[0]
            if (at === undefined) fail(index, op.op, 'no placement')

            // `embed` and `facets` are the model's own fields on the input
            // now, so they ride through `rest` rather than being unpacked
            // from a published extension key — see WRITE_EXTENSION.
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
            const parsed = spatialNodeSchema.safeParse({
              ...rest,
              // The draft's published `type` and content field become the
              // model's resource here, at the tool's boundary — see
              // `draftContent` for why that boundary exists at all.
              ...draftContent(draft),
              id,
              ...at,
              width,
              height,
            })
            if (!parsed.success) fail(index, op.op, s.issues(parsed.error))
            if (draft.height !== undefined && measure !== undefined) {
              assertTextFits(index, op.op, parsed.data, measure)
            }
            // A position the CALLER chose, in a group the caller named: both
            // are explicit, and the group grows so both hold — except before
            // its top-left, which growth keeps, so that one is refused.
            if (positioned && group !== undefined) {
              const unplaced = s.placedByCursor.get(group.id)
              if (unplaced !== undefined) {
                s.placeAround(index, op.op, group, [parsed.data], unplaced)
              } else {
                if (parsed.data.x < group.x || parsed.data.y < group.y) {
                  fail(index, op.op, outsideDetail(id, parsed.data, group))
                }
                s.growToHold(index, op.op, group, [parsed.data])
              }
            }
            s.nodes = [
              ...s.nodes,
              dressWithStencil(index, op.op, parsed.data, op.stencil, draft.color, facetRegistry),
            ]
            s.touchedNodes.add(id)
            if (!positioned) s.geometry.set(id, { id, ...at, width, height })
            if (!positioned && group === undefined && draft.type === 'group') {
              s.placedByCursor.set(id, { width: draft.width, height: draft.height })
            }
            return
          }

          case 'node.patch': {
            const ids = s.nodeTargets(index, op.op, op)
            // Locks are checked for the whole selection before any of it
            // changes, so a refusal leaves nothing half-applied.
            for (const id of ids) {
              if (s.nodeLocks.has(id)) {
                fail(index, op.op, `node "${id}" is locked; unlock it with a node.lock op first`)
              }
            }
            for (const id of ids) s.patchNode(index, op.op, id, op.patch)
            // After the patch, so an explicit `color` in the same op still
            // wins: a caller naming both has said the more specific thing.
            if (op.stencil !== undefined) {
              const stencil = op.stencil
              s.nodes = s.nodes.map((node) =>
                ids.includes(node.id)
                  ? dressWithStencil(index, op.op, node, stencil, op.patch.color, facetRegistry)
                  : node,
              )
            }
            return
          }

          case 'node.splice': {
            const node = s.nodeAt(op.id)
            if (node === undefined) fail(index, op.op, `node "${op.id}" is not on the canvas`)
            if (s.nodeLocks.has(op.id)) {
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
            if (!parsed.success) fail(index, op.op, s.issues(parsed.error))
            s.nodes = s.nodes.map((existing) => (existing.id === op.id ? parsed.data : existing))
            s.touchedNodes.add(op.id)
            return
          }

          case 'node.remove': {
            const ids = new Set(s.nodeTargets(index, op.op, op))
            for (const id of ids) {
              if (s.nodeLocks.has(id)) {
                fail(index, op.op, `node "${id}" is locked; unlock it with a node.lock op first`)
              }
            }
            // Edges touching a removed node go with it. Left behind they are
            // a canvas spatialCanvasSchema refuses on the next read, so
            // "apply exactly the op I was handed" would store a board that
            // cannot be loaded.
            for (const edge of s.edges) {
              if (endIn(edge.from, ids) || endIn(edge.to, ids)) s.touchedEdges.add(edge.id)
            }
            s.edges = s.edges.filter((edge) => !endIn(edge.from, ids) && !endIn(edge.to, ids))
            // Ink ANCHORED to a removed node goes with it for the same
            // reason; ink anchored to nothing stays, because a free end names
            // no node and so cannot dangle (ADR-0038 decision 2).
            for (const line of s.lines) {
              if (endIn(line.from, ids) || endIn(line.to, ids)) s.touchedLines.add(line.id)
            }
            s.lines = s.lines.filter((line) => !endIn(line.from, ids) && !endIn(line.to, ids))
            s.nodes = s.nodes.filter((node) => !ids.has(node.id))
            for (const id of ids) {
              s.nodeLocks.delete(id)
              s.touchedNodes.add(id)
            }
            return
          }

          case 'edge.add': {
            const draft = op.edge
            const id = draft.id ?? mintId(new Set(s.edges.map((edge) => edge.id)), 'e')
            if (s.edgeAt(id) !== undefined) {
              fail(
                index,
                op.op,
                `edge id "${id}" is already on the canvas; patch it or choose another id`,
              )
            }
            // A FREE end names no node, so there is nothing to be missing —
            // the existence check is about a reference, and a point is not one
            // (ADR-0037 slice 3).
            for (const endpoint of endNodes(draft)) {
              if (s.nodeAt(endpoint) === undefined) {
                fail(
                  index,
                  op.op,
                  `endpoint "${endpoint}" is not on the canvas; add that node first`,
                )
              }
            }
            const parsed = canvasEdgeSchema.safeParse({ ...draft, id })
            if (!parsed.success) fail(index, op.op, s.issues(parsed.error))
            s.edges = [...s.edges, parsed.data]
            s.touchedEdges.add(id)
            return
          }

          case 'edge.patch': {
            const edge = s.edgeAt(op.id)
            if (edge === undefined) fail(index, op.op, `edge "${op.id}" is not on the canvas`)
            if (s.edgeLocks.has(op.id)) {
              fail(index, op.op, `edge "${op.id}" is locked; unlock it with an edge.lock op first`)
            }
            const merged = { ...edge, ...op.patch }
            for (const endpoint of endNodes(merged)) {
              if (s.nodeAt(endpoint) === undefined) {
                fail(index, op.op, `endpoint "${endpoint}" is not on the canvas`)
              }
            }
            const parsed = canvasEdgeSchema.safeParse(merged)
            if (!parsed.success) fail(index, op.op, s.issues(parsed.error))
            const updated = parsed.data
            s.edges = s.edges.map((existing) => (existing.id === op.id ? updated : existing))
            s.touchedEdges.add(op.id)
            return
          }

          case 'edge.remove': {
            const ids = new Set(s.edgeTargets(index, op.op, op))
            for (const id of ids) {
              if (s.edgeLocks.has(id)) {
                fail(index, op.op, `edge "${id}" is locked; unlock it with an edge.lock op first`)
              }
            }
            s.edges = s.edges.filter((edge) => !ids.has(edge.id))
            for (const id of ids) {
              s.edgeLocks.delete(id)
              s.touchedEdges.add(id)
            }
            return
          }

          case 'line.add': {
            const draft = op.line
            const id = draft.id ?? mintId(new Set(s.lines.map((line) => line.id)), 'l')
            if (s.lineAt(id) !== undefined) {
              fail(
                index,
                op.op,
                `line id "${id}" is already on the canvas; patch it or choose another id`,
              )
            }
            for (const endpoint of endNodes(draft)) {
              if (s.nodeAt(endpoint) === undefined) {
                fail(
                  index,
                  op.op,
                  `endpoint "${endpoint}" is not on the canvas; add that node first`,
                )
              }
            }
            const parsed = canvasLineSchema.safeParse({ ...draft, id })
            if (!parsed.success) fail(index, op.op, s.issues(parsed.error))
            s.lines = [...s.lines, parsed.data]
            s.touchedLines.add(id)
            return
          }

          case 'line.patch': {
            const line = s.lineAt(op.id)
            if (line === undefined) fail(index, op.op, `line "${op.id}" is not on the canvas`)
            const merged = { ...line, ...op.patch }
            for (const endpoint of endNodes(merged)) {
              if (s.nodeAt(endpoint) === undefined) {
                fail(index, op.op, `endpoint "${endpoint}" is not on the canvas`)
              }
            }
            const parsed = canvasLineSchema.safeParse(merged)
            if (!parsed.success) fail(index, op.op, s.issues(parsed.error))
            s.lines = s.lines.map((existing) => (existing.id === op.id ? parsed.data : existing))
            s.touchedLines.add(op.id)
            return
          }

          case 'line.remove': {
            if (s.lineAt(op.id) === undefined) {
              fail(index, op.op, `line "${op.id}" is not on the canvas`)
            }
            s.lines = s.lines.filter((line) => line.id !== op.id)
            s.touchedLines.add(op.id)
            return
          }

          case 'node.lock':
            for (const id of s.nodeTargets(index, op.op, op)) {
              if (op.locked) s.nodeLocks.add(id)
              else s.nodeLocks.delete(id)
              s.touchedNodes.add(id)
            }
            return

          case 'edge.lock':
            for (const id of s.edgeTargets(index, op.op, op)) {
              if (op.locked) s.edgeLocks.add(id)
              else s.edgeLocks.delete(id)
              s.touchedEdges.add(id)
            }
            return

          case 'region.set': {
            let group = s.groupNamed(index, op.op, op.within)
            // A group this batch put at the cursor and never placed around
            // anything holds nothing, whatever the cursor's box covers.
            const unsettled =
              s.placedByCursor.get(group.id)?.placed !== true && s.placedByCursor.has(group.id)
            const inScope = unsettled ? [] : s.nodes.filter(s.enclosedBy(group))
            const inScopeIds = new Set(inScope.map((node) => node.id))
            const members = new Set(op.nodes)
            if (members.has(group.id)) {
              fail(index, op.op, `"${group.id}" is the group itself, not one of its members`)
            }
            for (const id of members) {
              if (s.nodeAt(id) === undefined) {
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
              if (s.nodeLocks.has(node.id)) {
                fail(index, op.op, `node "${node.id}" inside the region is locked`)
              }
            }
            for (const id of members) {
              if (!inScopeIds.has(id) && s.nodeLocks.has(id)) {
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
            const unplaced = s.placedByCursor.get(group.id)
            if (unplaced !== undefined && unsettled && members.size > 0) {
              const rects = [...members].map((id) => s.nodeAt(id) as SpatialNode)
              group = s.placeAround(index, op.op, group, rects, unplaced)
            }

            const dropped = inScope.filter((node) => !members.has(node.id))
            const droppedIds = new Set(dropped.map((node) => node.id))
            for (const node of dropped) {
              s.touchedNodes.add(node.id)
              s.nodeLocks.delete(node.id)
            }
            s.nodes = s.nodes.filter((node) => !droppedIds.has(node.id))

            // Members that are elsewhere come in, placed around the ones
            // already inside; the group grows if it has no room. A member
            // ACROSS the boundary is neither: that is the mid-drag case the
            // scope rule protects, so it is left exactly where it is.
            const arriving = op.nodes.filter((id) => {
              if (inScopeIds.has(id)) return false
              const node = s.nodeAt(id)
              return node === undefined || !overlaps(node, group)
            })
            const placements = s.placeInside(
              index,
              op.op,
              group,
              arriving.map((id) => {
                const node = s.nodeAt(id)
                return { width: node?.width ?? 0, height: node?.height ?? 0 }
              }),
            )
            arriving.forEach((id, at) => {
              const placed = placements[at]
              const node = s.nodeAt(id)
              if (placed === undefined || node === undefined) return
              const moved = { ...node, ...placed }
              s.nodes = s.nodes.map((candidate) => (candidate.id === id ? moved : candidate))
              s.touchedNodes.add(id)
              s.geometry.set(id, { id, ...placed, width: node.width, height: node.height })
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
                const edge = s.edgeAt(id)
                if (edge === undefined) fail(index, op.op, `edge "${id}" is not on the canvas`)
                for (const endpoint of endNodes(edge)) {
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
            for (const edge of s.edges) {
              const strandedBy = endIn(edge.from, droppedIds) || endIn(edge.to, droppedIds)
              const unlistedAmongMembers =
                keep !== undefined &&
                endIn(edge.from, members) &&
                endIn(edge.to, members) &&
                !keep.has(edge.id)
              if (strandedBy || unlistedAmongMembers) {
                removedEdges.add(edge.id)
                s.touchedEdges.add(edge.id)
                s.edgeLocks.delete(edge.id)
              }
            }
            s.edges = s.edges.filter((edge) => !removedEdges.has(edge.id))
            return
          }

          case 'comment.add': {
            const draft = op.comment
            const id = draft.id ?? mintId(new Set(s.comments.map((comment) => comment.id)), 'c')
            if (s.comments.some((comment) => comment.id === id)) {
              fail(index, op.op, `comment id "${id}" is already on the canvas`)
            }
            let at =
              draft.x !== undefined && draft.y !== undefined
                ? { x: draft.x, y: draft.y }
                : undefined
            if (at === undefined && draft.targetNodeId !== undefined) {
              const target = s.nodeAt(draft.targetNodeId)
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
            if (!parsed.success) fail(index, op.op, s.issues(parsed.error))
            s.comments = [...s.comments, parsed.data]
            s.touchedComments.add(id)
            return
          }

          case 'comment.resolve': {
            if (!s.comments.some((comment) => comment.id === op.id)) {
              fail(index, op.op, `comment "${op.id}" is not on the canvas`)
            }
            const resolved = op.resolved ?? true
            s.comments = s.comments.map((comment) =>
              comment.id === op.id ? { ...comment, resolved } : comment,
            )
            s.touchedComments.add(op.id)
            return
          }

          case 'tidy': {
            // Locks bind tidy exactly as they bind the editor: a locked node
            // is a fixed obstacle it routes around, never one it moves.
            const scope =
              op.within !== undefined
                ? s.nodeTargets(index, op.op, { within: op.within })
                : op.scope
            const moved = tidyNodes(tidyBoxes(s.nodes), {
              scope: scope === undefined ? undefined : new Set(scope),
              locked: (id) => s.nodeLocks.has(id),
              edges: s.edges,
            })
            const target = new Map(moved.map((move) => [move.id, move]))
            s.nodes = s.nodes.map((node) => {
              const move = target.get(node.id)
              if (move === undefined) return node
              // A frame that grew to hold its members carries its new size.
              const size = {
                width: move.width ?? node.width,
                height: move.height ?? node.height,
              }
              s.geometry.set(node.id, { id: node.id, x: move.x, y: move.y, ...size })
              s.touchedNodes.add(node.id)
              return { ...node, x: move.x, y: move.y, ...size }
            })
            return
          }
        }
      })

      // The batch writes back the WHOLE canvas, so the canvas's own facets —
      // and every comment the batch did not touch — must ride along, or the
      // save deletes them (writeSpatialCanvas resyncs by omission).
      const candidate: SpatialCanvas = {
        nodes: s.nodes,
        edges: s.edges,
        ...(canvas.facets !== undefined && { facets: canvas.facets }),
        ...(s.lines.length > 0 && { lines: s.lines }),
        ...(s.comments.length > 0 && { comments: s.comments }),
      }
      const parsed = spatialCanvasSchema.safeParse(candidate)
      if (!parsed.success) {
        throw new CanvasEditError(
          input.ops.length - 1,
          'batch',
          `the resulting canvas is not valid: ${parsed.error.issues}
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
            nodes: [...s.touchedNodes].sort(),
            edges: [...s.touchedEdges].sort(),
            lines: [...s.touchedLines].sort(),
            comments: [...s.touchedComments].sort(),
          },
          geometry: [...s.geometry.values()].sort((a, b) => a.id.localeCompare(b.id)),
          snapshot: projectCanvasSnapshot(input.documentId, canvas, s.nodeLocks, s.edgeLocks),
          proposed: proposal,
        }
      }

      // Locks are written only now, after every op has applied — see the
      // working-copy comment above.
      for (const node of parsed.data.nodes) setNodeLock(doc, node.id, s.nodeLocks.has(node.id))
      for (const edge of parsed.data.edges) setEdgeLock(doc, edge.id, s.edgeLocks.has(edge.id))
      await saveDocumentBodySnapshot(deps, input.workspaceId, input.documentId, doc, parsed.data)

      const touched = {
        nodes: [...s.touchedNodes].sort(),
        edges: [...s.touchedEdges].sort(),
        lines: [...s.touchedLines].sort(),
        comments: [...s.touchedComments].sort(),
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
        geometry: [...s.geometry.values()].sort((a, b) => a.id.localeCompare(b.id)),
        snapshot: projectCanvasSnapshot(input.documentId, parsed.data, s.nodeLocks, s.edgeLocks),
      }
    },
  }
}
