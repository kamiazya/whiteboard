import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { documentEngine as wire } from '@kamiazya/whiteboard-model'
import {
  CANVAS_EDGES_AND_LINES_LIMIT_PHRASE,
  CANVAS_MAX_EDGES_AND_LINES,
  CANVAS_MAX_NODES,
  CANVAS_NODES_LIMIT_PHRASE,
  compareCodeUnit,
  type ExtensionFacets,
  growsPast,
  type SpatialCanvas,
  spatialCanvasSchema,
} from '@kamiazya/whiteboard-model'
import { type DocumentSession, withDocument } from '../document-session.js'
import { canvasOf, edgeLocksOf, kindOf, nodeLocksOf } from '../document-session-reads.js'
import { resolveTextMeasurer } from '../render/text-measurer.js'
import type { ServerDeps } from '../server-deps.js'
import { announceAgentActivity, notificationFailed } from './agent-activity.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { CanvasEditError, describeIssues, fail } from './canvas-edit-error.js'
import { applyCanvasOp, type CanvasEditContext } from './canvas-edit-handlers.js'
import {
  type CanvasEditInput,
  type CanvasEditOutput,
  type CanvasEditTouched,
  canvasEditInputSchema,
  canvasEditOutputSchema,
} from './canvas-edit-ops.js'
import { CanvasEditSession } from './canvas-edit-session.js'
import { isProposableOp, storeCanvasProposal } from './canvas-propose.js'
import { projectCanvasSnapshot } from './canvas-snapshot.js'
import { DocumentKindMismatchError } from './errors.js'
import { facetWriterFor } from './facet-write.js'
import { withWorkspaceWrite } from './write-lock.js'

export { canvasEditInputSchema } from './canvas-edit-ops.js'
export { PLACEMENT_COLUMNS, PLACEMENT_GUTTER_PX } from './canvas-edit-placement.js'

// What a batch needs is decided from its OPS, and each of these is resolved
// only when some op asks for it.
//
// This is the hottest write tool there is: the overwhelming majority of
// batches move boxes and draw lines, and none of them should pay for a
// vocabulary or a measurer they never mention. Inlined in `execute` the three
// lazy resolutions read as incidental conditions; named, each carries the
// reason it is lazy beside the predicate that decides it.

/**
 * The facets buckets a batch's ops write. Locks and tidy carry none,
 * and `node.patch` has no `facets` field at all — `wb_facet_set` is where a
 * node's facets change.
 */
function facetBucketsOf(ops: CanvasEditInput['ops']): (ExtensionFacets | undefined)[] {
  return ops.map((op) => {
    switch (op.op) {
      case 'node.add':
        return op.node.facets
      case 'edge.add':
        return op.edge.facets
      case 'line.add':
        return op.line.facets
      case 'edge.patch':
      case 'line.patch':
        return op.patch.facets
      default:
        return undefined
    }
  })
}

/**
 * The deployment's registry PLUS this workspace's own stencil library, which
 * is a document in it (ADR-0034 decision 4).
 *
 * Two scopes: a plugin set is chosen once per server because facet schemas are
 * fixed at distribution time, and a library is content that belongs to the
 * workspace holding it. A workspace with no library gets the base registry
 * back unchanged, same instance. Resolved only for a batch that NAMES a
 * stencil — by `stencil` on an op or by a facets bucket whose facet takes one
 * — because finding the library costs a document listing plus a read. The
 * registry validates every facets bucket and resolves stencils, and the
 * library adds stencil assets and nothing else, which is what makes resolving
 * it lazily safe rather than clever.
 */
async function resolveEditWriter(deps: ServerDeps, input: CanvasEditInput) {
  const namesAStencil = input.ops.some(
    (op) => 'stencil' in op && (op as { stencil?: string }).stencil !== undefined,
  )
  return await facetWriterFor(deps, input.workspaceId, facetBucketsOf(input.ops), namesAStencil)
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
async function claimSpatialDocument(session: DocumentSession, documentId: string): Promise<void> {
  const kind = await kindOf(session)
  if (kind === undefined) {
    session.write([{ op: 'writeDocumentKind', args: { kind: 'spatial' } }])
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
  input,
  session,
  canvas,
  after,
  s,
}: {
  input: CanvasEditInput
  session: DocumentSession
  canvas: SpatialCanvas
  after: SpatialCanvas
  s: CanvasEditSession
}): Promise<CanvasEditOutput> {
  const proposal = await storeCanvasProposal({
    session,
    input,
    before: canvas,
    after,
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
    touched: sortedTouched(s),
    geometry: [...s.geometry.values()].sort((a, b) => compareCodeUnit(a.id, b.id)),
    snapshot: projectCanvasSnapshot(input.documentId, canvas, s.nodeLocks, s.edgeLocks),
    proposed: proposal,
  }
}

/**
 * What the batch touched, sorted so the payload is reproducible rather than
 * carrying Set iteration order. Typed as the notifier port's shape so the
 * tool's answer and the browser's outline are built from one object.
 */
function sortedTouched(s: CanvasEditSession): CanvasEditTouched {
  return {
    nodes: [...s.touchedNodes].sort(),
    edges: [...s.touchedEdges].sort(),
    lines: [...s.touchedLines].sort(),
  }
}

/**
 * Tell a watching human what landed — only now, with the write committed.
 *
 * A human must never be shown an edit that was refused, so nothing before the
 * save calls this. The viewport request is wrapped for the same reason
 * `announceAgentActivity` is: the batch is already on disk.
 *
 * Awaited, as it was inline: the viewport request is part of what the caller
 * asked for when it left `follow` on, and returning before it is sent would
 * race the very jump it asks for.
 */
async function announceEdit(
  deps: ServerDeps,
  input: CanvasEditInput,
  touched: CanvasEditTouched,
): Promise<void> {
  const { workspaceId, documentId } = input
  announceAgentActivity(deps, { workspaceId, documentId, ...touched }, summarizeOps(input.ops))
  const notifier = deps.clientNotifier
  // An empty `elementIds` with `mode: 'fit'` fits the WHOLE board,
  // which is a jarring jump for an edit that only touched an edge —
  // so a batch that moved no node moves no viewport either.
  if (notifier === undefined || input.follow === false || touched.nodes.length === 0) return
  try {
    await notifier.requestViewport({
      workspaceId,
      documentId,
      mode: 'fit',
      elementIds: touched.nodes,
    })
  } catch (err) {
    notificationFailed(input, 'requestViewport', err)
  }
}

type CanvasOp = CanvasEditInput['ops'][number]

type SummaryBucket = 'added' | 'changed' | 'removed' | 'locked' | 'unlocked' | 'tidied'

/**
 * Which tally each op contributes to. Keyed by the op union, so a new op owes
 * an answer here before it compiles. `null` is a deliberate silence:
 * `node.splice` rewrites part of a body and `region.set` restates a group's
 * membership, and neither reads as one of the tallies a person counts. A
 * lock's tally depends on the op's own `locked`.
 */
const OP_SUMMARY_BUCKET = {
  'node.add': () => 'added',
  'edge.add': () => 'added',
  'line.add': () => 'added',
  'node.patch': () => 'changed',
  'edge.patch': () => 'changed',
  'line.patch': () => 'changed',
  'node.remove': () => 'removed',
  'edge.remove': () => 'removed',
  'line.remove': () => 'removed',
  'node.lock': (op) => (op.locked ? 'locked' : 'unlocked'),
  'edge.lock': (op) => (op.locked ? 'locked' : 'unlocked'),
  tidy: () => 'tidied',
  'node.splice': null,
  'region.set': null,
} as const satisfies {
  [K in CanvasOp['op']]: ((op: Extract<CanvasOp, { op: K }>) => SummaryBucket) | null
}

/** The order a summary reads in; each tally is reported under its own name. */
const SUMMARY_ORDER: readonly SummaryBucket[] = [
  'added',
  'changed',
  'removed',
  'locked',
  'unlocked',
]

function summaryBucketOf(op: CanvasOp): SummaryBucket | undefined {
  const bucketOf = OP_SUMMARY_BUCKET[op.op] as ((op: CanvasOp) => SummaryBucket) | null
  return bucketOf === null ? undefined : bucketOf(op)
}

/**
 * One human-readable line for the toast a browser shows. Counted from the
 * OPS rather than from `touched`, because "added 3 nodes" and "moved 3
 * nodes" are the same set of ids and a human needs to know which happened.
 */
function summarizeOps(ops: readonly CanvasOp[]): string {
  const counts = new Map<SummaryBucket, number>()
  for (const op of ops) {
    const bucket = summaryBucketOf(op)
    if (bucket !== undefined) counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const parts = SUMMARY_ORDER.filter((word) => (counts.get(word) ?? 0) > 0).map(
    (word) => `${word} ${counts.get(word)}`,
  )
  if ((counts.get('tidied') ?? 0) > 0) parts.push('tidied the layout')
  // Reached by a batch made only of the ops the table leaves silent.
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
      'Apply a batch of edits to a spatial canvas in one transaction: add, patch, remove, lock and tidy nodes and edges. Comments are not ops here; open, reply to and resolve them with wb_thread_edit. Either every op applies or none does, and a refusal names the op that failed. Node geometry is optional — a node with no x/y/width/height is placed for you and the chosen position is reported back. The result carries the resulting board, so there is no need to read it again. A batch of CONTENT changes is stored as a proposal for a person to adopt or dismiss rather than changing the document — that is the default, because nobody watches you type. Pass mode:"apply" to change the document directly, which is what to do when a person just asked you to draw. A batch carrying anything a proposal cannot represent — locks, tidy, region.set — applies when no mode is given, since those are not content; an explicit mode:"propose" refuses such a batch. Pass proposalId to keep several calls in one proposal.',
    inputSchema: canvasEditInputSchema,
    outputSchema: canvasEditOutputSchema,
    execute(input: CanvasEditInput): Promise<CanvasEditOutput> {
      return withWorkspaceWrite(deps, input.workspaceId, () => editCanvas(deps, input))
    },
  }
}

/**
 * The canvas after the batch: the session's working copy of what ops reach,
 * with the envelope ops cannot reach (the canvas's own facets and tags) carried
 * over — the save diffs against what was loaded, so a field left out here is a
 * field the save deletes.
 */
function editedCanvas(canvas: SpatialCanvas, s: CanvasEditSession): SpatialCanvas {
  return {
    nodes: s.nodes,
    edges: s.edges,
    ...(canvas.facets !== undefined && { facets: canvas.facets }),
    ...(canvas.tags !== undefined && { tags: canvas.tags }),
    ...(s.lines.length > 0 && { lines: s.lines }),
  }
}

/**
 * Refuses the op that takes the board past a per-canvas ceiling, judged
 * against the board as loaded: a canvas stored past one still takes a batch
 * that ends no larger than it began, so removing is how it shrinks.
 */
function refuseCanvasGrowth(
  canvas: SpatialCanvas,
  s: CanvasEditSession,
  index: number,
  op: string,
): void {
  if (growsPast(CANVAS_MAX_NODES, canvas.nodes.length, s.nodes.length)) {
    fail(
      index,
      op,
      `the canvas would hold ${s.nodes.length} nodes, past ${CANVAS_NODES_LIMIT_PHRASE}`,
    )
  }
  // One bound for both: the layout routes edges and lines through one pipeline.
  const routedBefore = canvas.edges.length + (canvas.lines?.length ?? 0)
  const routed = s.edges.length + s.lines.length
  if (growsPast(CANVAS_MAX_EDGES_AND_LINES, routedBefore, routed)) {
    fail(
      index,
      op,
      `the canvas would hold ${routed} edges and lines, past ${CANVAS_EDGES_AND_LINES_LIMIT_PHRASE}`,
    )
  }
}

async function editCanvas(deps: ServerDeps, input: CanvasEditInput): Promise<CanvasEditOutput> {
  const facetWriter = await resolveEditWriter(deps, input)
  const proposing = decideProposing(input)
  await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
  return withDocument(deps, input.workspaceId, input.documentId, async (session) => {
    const canvas = await canvasOf(session)
    await claimSpatialDocument(session, input.documentId)
    const s = await sessionFor(deps, session, input, canvas)
    const after = resolveBatch(s, facetWriter, input, canvas)
    if (proposing) return await commitAsProposal({ input, session, canvas, after, s })
    return await commitBatch({ deps, input, session, canvas, after, s })
  })
}

/**
 * The working copy every op of the batch runs against. Nothing reaches the
 * document until the last op has applied — that is what makes the batch
 * all-or-nothing — including the lock ops, which would otherwise write
 * through to the document's lock sets as they were applied.
 */
async function sessionFor(
  deps: ServerDeps,
  session: DocumentSession,
  input: CanvasEditInput,
  canvas: SpatialCanvas,
): Promise<CanvasEditSession> {
  const measure = await resolveMeasurerFor(deps, input.ops)
  // The core sizes what the measurer would and arranges a tidy, so it is asked
  // for only when a batch needs one of them.
  const core =
    measure === undefined && !input.ops.some((op) => op.op === 'tidy')
      ? undefined
      : await deps.layoutCore()
  const locks = { nodes: await nodeLocksOf(session), edges: await edgeLocksOf(session) }
  return new CanvasEditSession(canvas, locks, measure, core)
}

/** Runs every op on `s` and answers the canvas that results, or the op that refused. */
function resolveBatch(
  s: CanvasEditSession,
  facetWriter: Awaited<ReturnType<typeof resolveEditWriter>>,
  input: CanvasEditInput,
  canvas: SpatialCanvas,
): SpatialCanvas {
  // One handler per verb, keyed by the schema (canvas-edit-handlers.ts).
  // A verb added to the schema and not to the table does not compile, where
  // an inline switch would simply fall through and report a batch applied
  // having ignored the op.
  const ctx: CanvasEditContext = { s, facetWriter }
  input.ops.forEach((op, index) => {
    applyCanvasOp(ctx, op, index)
    refuseCanvasGrowth(canvas, s, index, op.op)
  })

  const parsed = spatialCanvasSchema.safeParse(editedCanvas(canvas, s))
  if (!parsed.success) {
    throw new CanvasEditError(
      input.ops.length - 1,
      'batch',
      `the resulting canvas is not valid: ${describeIssues(parsed.error)}`,
    )
  }
  return parsed.data
}

async function commitBatch({
  deps,
  input,
  session,
  canvas,
  after,
  s,
}: {
  deps: ServerDeps
  input: CanvasEditInput
  session: DocumentSession
  canvas: SpatialCanvas
  after: SpatialCanvas
  s: CanvasEditSession
}): Promise<CanvasEditOutput> {
  // The diff against what was loaded, never a resync from `after` alone: the
  // canvas read skips every stored record its schema refuses — typically one a
  // newer client wrote — and a resync would delete each of them as an op that
  // ships to every replica. Locks are written first, then the canvas.
  //
  // This is a read-modify-write with no optimistic-concurrency check: two
  // concurrent patches against the same canvas race, and the later save wins
  // outright. An accepted limitation, not an oversight.
  //
  // ponytail: last-write-wins on the whole canvas; a per-element compare-and-set
  // if concurrent patching turns out to be a real pattern rather than a race
  // two agents hit occasionally.
  session.write([
    ...after.nodes.map(({ id }) => lockWrite('setNodeLock', id, s.nodeLocks.has(id))),
    ...after.edges.map(({ id }) => lockWrite('setEdgeLock', id, s.edgeLocks.has(id))),
    { op: 'reconcileSpatialCanvas', args: { prev: canvas, next: after } },
  ])
  await session.save()

  const touched = sortedTouched(s)

  await announceEdit(deps, input, touched)

  return {
    documentId: input.documentId,
    applied: input.ops.length,
    touched,
    geometry: [...s.geometry.values()].sort((a, b) => compareCodeUnit(a.id, b.id)),
    snapshot: projectCanvasSnapshot(input.documentId, after, s.nodeLocks, s.edgeLocks),
  }
}

function lockWrite(op: 'setNodeLock' | 'setEdgeLock', id: string, locked: boolean): wire.Write {
  return { op, args: { id, locked } }
}
