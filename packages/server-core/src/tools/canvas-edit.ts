import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import {
  readDocumentKind,
  setEdgeLock,
  setNodeLock,
  writeDocumentKind,
} from '@kamiazya/whiteboard-loro-adapter'
import { type SpatialCanvas, spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { resolveTextMeasurer } from '../render/text-measurer.js'
import type { CanvasOpSummaryInput, ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { CanvasEditError, fail } from './canvas-edit-error.js'
import { applyCanvasOp, type CanvasEditContext } from './canvas-edit-handlers.js'
import {
  type CanvasEditInput,
  type CanvasEditOutput,
  canvasEditInputSchema,
  canvasEditOutputSchema,
} from './canvas-edit-ops.js'
import { CanvasEditSession } from './canvas-edit-session.js'
import { isProposableOp, storeCanvasProposal } from './canvas-propose.js'
import { projectCanvasSnapshot } from './canvas-snapshot.js'
import { loadDocument, saveDocumentBodySnapshot } from './document-io.js'
import { DocumentKindMismatchError } from './errors.js'
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

      // One handler per verb, keyed by the schema (canvas-edit-handlers.ts).
      // It was a 16-case switch inline here, and the shape is what changed:
      // a verb added to the schema and not to the table no longer compiles,
      // where the switch simply fell through and reported a batch applied
      // having ignored the op.
      const ctx: CanvasEditContext = { s, facetRegistry }
      input.ops.forEach((op, index) => {
        applyCanvasOp(ctx, op, index)
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
