import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import {
  readDocumentKind,
  setEdgeLock,
  setNodeLock,
  writeDocumentKind,
} from '@kamiazya/whiteboard-loro-adapter'
import { type SpatialCanvas, spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import type { LoroDoc } from 'loro-crdt'
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
/**
 * What a batch needs is decided from its OPS, and each of these is resolved
 * only when some op asks for it.
 *
 * This is the hottest write tool there is: the overwhelming majority of
 * batches move boxes and draw lines, and none of them should pay for a
 * vocabulary or a measurer they never mention. Inlined in `execute` the three
 * lazy resolutions read as incidental conditions; named, each carries the
 * reason it is lazy beside the predicate that decides it.
 */

/**
 * The deployment's registry PLUS this workspace's own stencil library, which
 * is a document in it (ADR-0034 decision 4).
 *
 * Two scopes: a plugin set is chosen once per server because facet schemas are
 * fixed at distribution time, and a library is content that belongs to the
 * workspace holding it. A workspace with no library gets the base registry
 * back unchanged, same instance. Resolved only for a batch that NAMES a
 * stencil, because finding the library costs a document listing plus a read.
 * `facetRegistry` is used for stencils and nothing else here, which is what
 * makes that safe rather than clever.
 */
async function resolveEditRegistry(deps: ServerDeps, input: CanvasEditInput) {
  const namesAStencil = input.ops.some(
    (op) => 'stencil' in op && (op as { stencil?: string }).stencil !== undefined,
  )
  return namesAStencil
    ? await workspaceFacetRegistry(deps, input.workspaceId, 'deployment')
    : (deps.facetRegistry ?? bundledFacetRegistry)
}

/**
 * Whether this batch is stored as a proposal, refusing an EXPLICIT propose it
 * cannot honour.
 *
 * An omitted mode proposes only a batch every op of which COULD be proposed;
 * see the field's own note for why that line and not "propose unless told
 * otherwise". Only an explicit propose can be refused: the default never
 * chooses to propose a batch it would then have to reject.
 */
function decideProposing(input: CanvasEditInput): boolean {
  if (input.mode === undefined) return input.ops.every((op) => isProposableOp(op.op))
  if (input.mode !== 'propose') return false
  const refused = input.ops.findIndex((op) => !isProposableOp(op.op))
  if (refused >= 0) {
    fail(
      refused,
      input.ops[refused]?.op ?? 'unknown',
      'a proposal cannot carry this verb: it has no single anchor to follow, ' +
        'or it changes what it was not asked about, so nobody could adopt part of it',
    )
  }
  return true
}

/**
 * Claim an unkinded document as spatial, and refuse a markdown one.
 *
 * Same rule as the single-purpose adds this replaced: a markdown document
 * keeps its OKF body in a text node, so spatial ops on it would not fail, they
 * would land beside the body and corrupt it.
 */
function claimSpatialDocument(doc: LoroDoc, documentId: string): void {
  const kind = readDocumentKind(doc)
  if (kind === undefined) {
    writeDocumentKind(doc, 'spatial')
    return
  }
  if (kind !== 'spatial') {
    throw new DocumentKindMismatchError(
      documentId,
      kind,
      "This edits a JSON Canvas, and its only node holds its OKF body. Write its content through `wb_workspace_edit`'s `document.set` op, or a passage of its body through wb_body_edit.",
    )
  }
}

/**
 * A text measurer, resolved only when some op creates a text node or changes
 * what decides whether one's text fits — the composition root's measurer
 * parses a font on first use, and a batch of moves and locks should not pay
 * for that.
 *
 * `region.set` is deliberately NOT included: what it declares must fit inside
 * its group, so growing a node there could refuse the very op that asked for
 * it. A node created there keeps the flat default.
 */
async function resolveMeasurerFor(
  deps: ServerDeps,
  ops: CanvasEditInput['ops'],
): Promise<MeasureText | undefined> {
  const wantsFit = ops.some(
    (op) =>
      (op.op === 'node.add' && op.node.type === 'text') ||
      (op.op === 'node.patch' &&
        (op.patch.text !== undefined ||
          op.patch.width !== undefined ||
          op.patch.height !== undefined)),
  )
  return wantsFit ? (await resolveTextMeasurer(deps)).measure : undefined
}

/**
 * Store the batch as a PROPOSAL instead of the board it describes.
 *
 * The content containers are left exactly as they were and only the proposals
 * plane grows. Locks are not written either — a lock is a claim on the
 * document, and this batch has not touched the document.
 *
 * Deliberately silent: nothing changed for a watching browser, so a toast
 * saying "changed 1" would be a lie, and the viewport must not chase an edit
 * nobody made. The editor draws the proposal itself — an outline where each
 * change would land, and a bubble carrying the count — which is the
 * announcement, and it needs no toast.
 */
async function commitAsProposal({
  deps,
  input,
  doc,
  canvas,
  after,
  s,
}: {
  deps: ServerDeps
  input: CanvasEditInput
  doc: LoroDoc
  canvas: SpatialCanvas
  after: SpatialCanvas
  s: CanvasEditSession
}): Promise<CanvasEditOutput> {
  const proposal = await storeCanvasProposal({
    deps,
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
    doc,
    before: canvas,
    after: after,
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

/**
 * Tell a watching human what landed — only now, with the write committed.
 *
 * A human must never be shown an edit that was refused, so nothing before the
 * save calls this. Both calls are wrapped because the batch is already on disk
 * by the time anyone is told: letting a broken socket surface as a tool error
 * would report a failure for an edit that SUCCEEDED. The implementation is
 * expected to handle its own transport errors — this is the belt, and
 * server-core has no logger of its own to record it.
 *
 * Awaited, as it was inline: the viewport request is part of what the caller
 * asked for when it left `follow` on, and returning before it is sent would
 * race the very jump it asks for.
 */
async function announceEdit(
  deps: ServerDeps,
  input: CanvasEditInput,
  touched: {
    readonly nodes: string[]
    readonly edges: string[]
    readonly lines: string[]
    readonly comments: string[]
  },
): Promise<void> {
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
}

type SummaryBucket = 'added' | 'changed' | 'removed' | 'commented' | 'resolved' | 'tidied'

/**
 * Which tally an op contributes to, as a table.
 *
 * A chain of `else if`s said the same thing and hid the one fact a reader
 * wants: which verbs are summarised and which are silent. `node.splice` and
 * `region.set` are ABSENT here, which is the behaviour the chain had — they
 * fall through it — and absence now reads as a decision rather than as the
 * end of a list.
 *
 * `node.lock` / `edge.lock` are absent for a different reason: which tally
 * they land in depends on the op's own `locked`, so they are resolved below.
 * The table cannot be `satisfies Record<op, …>`: `CanvasOpSummaryInput` is
 * deliberately structural (`{ op: string }`) so the notifier contract does not
 * depend on the op union.
 */
const OP_SUMMARY_BUCKET: Readonly<Record<string, SummaryBucket>> = {
  'node.add': 'added',
  'edge.add': 'added',
  'line.add': 'added',
  'node.patch': 'changed',
  'edge.patch': 'changed',
  'line.patch': 'changed',
  'node.remove': 'removed',
  'edge.remove': 'removed',
  'line.remove': 'removed',
  'comment.add': 'commented',
  'comment.resolve': 'resolved',
  tidy: 'tidied',
}

/** The order a summary reads in, with the word each tally is reported as. */
const SUMMARY_ORDER: readonly (readonly [SummaryBucket | 'locked' | 'unlocked', string])[] = [
  ['added', 'added'],
  ['changed', 'changed'],
  ['removed', 'removed'],
  ['locked', 'locked'],
  ['unlocked', 'unlocked'],
  ['commented', 'commented'],
  ['resolved', 'resolved'],
]

function summarizeOps(ops: readonly CanvasOpSummaryInput[]): string {
  const counts = new Map<string, number>()
  for (const op of ops) {
    const bucket =
      op.op === 'node.lock' || op.op === 'edge.lock'
        ? op.locked
          ? 'locked'
          : 'unlocked'
        : OP_SUMMARY_BUCKET[op.op]
    if (bucket !== undefined) counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const parts = SUMMARY_ORDER.filter(([bucket]) => (counts.get(bucket) ?? 0) > 0).map(
    ([bucket, word]) => `${word} ${counts.get(bucket)}`,
  )
  if ((counts.get('tidied') ?? 0) > 0) parts.push('tidied the layout')
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
      const facetRegistry = await resolveEditRegistry(deps, input)
      const proposing = decideProposing(input)
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const { doc, canvas } = await loadDocument(deps, input.workspaceId, input.documentId)
      claimSpatialDocument(doc, input.documentId)
      const measure = await resolveMeasurerFor(deps, input.ops)

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

      if (proposing) {
        return await commitAsProposal({ deps, input, doc, canvas, after: parsed.data, s })
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

      await announceEdit(deps, input, touched)

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
