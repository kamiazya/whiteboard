import {
  readDocumentKind,
  readMarkdownBody,
  readProposals,
  writeMarkdownBody,
  writeProposal,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  applyPassages,
  type BodyProposedChange,
  bodyChangeConflicts,
  bodyReplaceChangeSchema,
  documentIdSchema,
  findPassageOverlap,
  growsPast,
  MARKDOWN_MAX_CHARS,
  mintProposalId,
  type PassageOverlap,
  type PlacedPassage,
  type Proposal,
  proposalSchema,
  resolveTextAnchor,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { loadDocument, saveDocumentSnapshot } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { DocumentKindMismatchError, PassageNotApplicableError } from './errors.js'
import { proposalAuthorSchema } from './proposal-author.js'
import { withWorkspaceWrite } from './write-lock.js'

/**
 * One proposed passage as a CALLER sends it: the model's own `body.replace`
 * minus `status`, which is a verdict the document keeps rather than something
 * an agent declares. Omitted from the model schema rather than restated, so
 * the wire shape and the shape a person's card decides on cannot drift.
 */
const bodyEditOpSchema = bodyReplaceChangeSchema.omit({ status: true })
type BodyEditOp = z.infer<typeof bodyEditOpSchema>

export const bodyEditInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    /**
     * `propose` by default, the same rule decision 7 gives `wb_canvas_edit`:
     * a batch of CONTENT changes is stored for a person to adopt rather than
     * changing the document, because nobody watches an agent type. It
     * resolves trivially here — every op this tool takes is a change to the
     * body, so there is no non-content half for a batch to be mixed with.
     */
    mode: z.enum(['apply', 'propose']).optional(),
    /**
     * Keeps several calls in one proposal (decision 8: the batch is one
     * REQUEST, which often takes more than one call). Absent, a proposing
     * call opens its own.
     */
    proposalId: z.string().min(1).optional(),
    /** Only meaningful when proposing; see `proposalAuthorSchema`. */
    author: proposalAuthorSchema,
    ops: z.array(bodyEditOpSchema).min(1, 'a body edit carries at least one passage'),
  })
  .strict()
export type BodyEditInput = z.infer<typeof bodyEditInputSchema>

const bodyEditOutputSchema = z
  .object({
    documentId: documentIdSchema,
    /** How many passages the body now holds differently. Zero when proposing. */
    applied: z.number().int().nonnegative(),
    /**
     * The proposal these passages went into, when they were not applied —
     * read back from the document rather than recomputed, so a call
     * continuing an existing proposal answers with everything a person will
     * be shown, not only what this call contributed. Same schema the
     * document stores, so there is no second shape to keep in step.
     */
    proposed: proposalSchema.optional(),
    body: z.string(),
  })
  .strict()
export type BodyEditOutput = z.infer<typeof bodyEditOutputSchema>

/**
 * Every op paired with where `body` holds its passage, or a refusal naming
 * the first that cannot be placed.
 *
 * Placement happens for the WHOLE batch before anything is written, and one
 * unplaceable op refuses all of them. A partial result would leave the caller
 * holding a document that is neither what it had nor what it asked for, and
 * nothing in the result could say which passages landed in a way the next
 * call could act on — the same reason `wb_canvas_edit` is all-or-nothing.
 *
 * A passage that resolves NOWHERE is refused in both modes, not only when
 * applying. Decision 1 says a proposal is drawn in place; an anchor matching
 * nothing has no place to be drawn, so storing it would put a change on the
 * document that no surface could ever show. Whether the passage still READS
 * what the caller assumed is a different question, and belongs to the mode.
 */
function placeAll(
  body: string,
  ops: readonly BodyEditOp[],
  taken: ReadonlySet<string> = new Set(),
): PlacedPassage[] {
  const seen = new Set<string>(taken)
  const placed: PlacedPassage[] = []
  for (const op of ops) {
    if (seen.has(op.id)) {
      throw new PassageNotApplicableError(
        op.id,
        taken.has(op.id)
          ? 'the proposal this call continues already holds a change with that id, and storing it would replace that change rather than add one'
          : 'two passages in this call share that change id, and an Adopt naming it could not tell them apart',
      )
    }
    seen.add(op.id)
    // `nodeId` is the anchor's way of naming a text node, which a markdown
    // document has none of; resolving against the body would apply the edit to
    // a passage the caller placed somewhere else.
    if (op.anchor.nodeId !== undefined) {
      throw new PassageNotApplicableError(
        op.id,
        `a markdown document has no node "${op.anchor.nodeId}"; omit nodeId to quote its body`,
      )
    }
    const resolved = resolveTextAnchor(body, op.anchor)
    if (resolved.kind !== 'placed') {
      throw new PassageNotApplicableError(op.id, 'its passage is no longer in the body')
    }
    placed.push({ change: { ...op, status: 'open' }, at: resolved })
  }
  return placed
}

/**
 * The passages a proposal ALREADY holds, placed against the body as it now
 * stands — the set a whole-proposal Adopt would apply alongside whatever this
 * call adds.
 *
 * Only OPEN changes: an adopted or dismissed one is not in that set, so it
 * reserves nothing and must not block a later passage. Only `body.replace`
 * ones, since a canvas change is about a different surface. And only those
 * that still RESOLVE — a change whose passage has since vanished cannot be
 * applied either, so letting it forbid an overlap would be a phantom
 * refusing real work.
 */
function placeExisting(body: string, proposal: Proposal | undefined): PlacedPassage[] {
  if (proposal === undefined) return []
  const placed: PlacedPassage[] = []
  for (const change of proposal.changes) {
    if (change.op !== 'body.replace' || change.status !== 'open') continue
    const resolved = resolveTextAnchor(body, change.anchor)
    if (resolved.kind !== 'placed') continue
    placed.push({ change, at: resolved })
  }
  return placed
}

/**
 * The refusal for two passages that reach into one another — what overlapping
 * means, and why applying them would corrupt the body, is `applyPassages`'s.
 */
function overlapRefusal({ passage, overlaps }: PassageOverlap): PassageNotApplicableError {
  return new PassageNotApplicableError(
    passage.change.id,
    `its passage [${passage.at.start}, ${passage.at.end}) overlaps ${overlaps.change.id}'s [${overlaps.at.start}, ${overlaps.at.end}) — applying both would write text neither one proposed`,
  )
}

/**
 * Refuses a batch whose passages reach into one another.
 *
 * Checked when proposing too, since a whole-proposal Adopt applies exactly
 * this set and would corrupt the body the same way — later, and further from
 * the call that caused it.
 *
 * A placed range is never empty here: `resolveTextAnchor` places a passage by
 * finding `quote.exact`, which the schema requires to be at least one
 * character, so the degenerate zero-length case a strict overlap test would
 * miss cannot arise.
 */
function assertDisjoint(placed: readonly PlacedPassage[]): void {
  const overlap = findPassageOverlap(placed)
  if (overlap !== undefined) throw overlapRefusal(overlap)
}

/** The body once every placed passage is applied, or the overlap's refusal. */
function applyPlaced(body: string, placed: readonly PlacedPassage[]): string {
  const outcome = applyPassages(body, placed)
  if (outcome.kind === 'overlap') throw overlapRefusal(outcome)
  return outcome.body
}

/**
 * Refuses a batch that would leave the body longer than a whole-document write
 * may be (`MARKDOWN_MAX_CHARS`). A replacement reaches the CRDT as the same
 * text insert a create does, so growing a body past the limit by editing costs
 * what writing it past the limit would, and a PROPOSAL is held to it too:
 * adopting one that cannot apply is a change nobody can accept.
 *
 * Only growth is refused. A body written before the limit existed stays
 * editable toward it, which a flat length test would forbid.
 *
 * `result` may hold more than `placed` — a proposal's earlier passages — and
 * the change named is the largest grower among `placed` alone.
 */
function assertWithinLimit(body: string, placed: readonly PlacedPassage[], result: string): void {
  if (!growsPast(MARKDOWN_MAX_CHARS, body.length, result.length)) return
  const growth = (entry: PlacedPassage): number =>
    entry.change.text.length - (entry.at.end - entry.at.start)
  const largest = placed.reduce((a, b) => (growth(b) > growth(a) ? b : a))
  throw new PassageNotApplicableError(
    largest.change.id,
    `the edit would leave the body ${result.length} characters, over the ${MARKDOWN_MAX_CHARS}-character limit for one write; split the content across documents`,
  )
}

/**
 * Refuses a batch that would rewrite words the caller did not see — the
 * APPLY-side half of decision 5.
 *
 * Not asked when proposing. A proposal follows the document, and a passage
 * that has changed since it was written is precisely the collision the person
 * deciding needs to be shown; refusing it at the door would throw away the
 * proposal rather than surface the disagreement.
 */
function assertAssumptionsHold(placed: readonly PlacedPassage[], body: string): void {
  for (const { change, at } of placed) {
    if (!bodyChangeConflicts(change, body, at)) continue
    throw new PassageNotApplicableError(
      change.id,
      `the body now reads ${JSON.stringify(body.slice(at.start, at.end))} there, not ${JSON.stringify(change.assumed)}`,
    )
  }
}

/**
 * Stores the passages as a proposal INSTEAD of writing them: the body is left
 * exactly as it was and only the proposals plane grows.
 *
 * Unlike the canvas side there is no diff to take. `wb_canvas_edit` resolves
 * a batch and reads the changes off the difference, because a proposed node
 * has to be stored with an id and geometry the caller never sent. A passage
 * arrives already in the stored shape — decision 6's replacement passage IS
 * `body.replace` — so carrying it through is not a shortcut, it is the
 * absence of a translation that could disagree with itself.
 */
async function storeBodyProposal(args: {
  readonly deps: ServerDeps
  readonly input: Pick<BodyEditInput, 'workspaceId' | 'documentId' | 'proposalId' | 'author'>
  readonly doc: LoroDoc
  readonly changes: readonly BodyProposedChange[]
}): Promise<Proposal> {
  const { deps, input, doc } = args
  const open = readProposals(doc)
  const continuing = open.find((existing) => existing.id === input.proposalId)
  const proposal: Proposal = {
    id: input.proposalId ?? mintProposalId(new Set(open.map((existing) => existing.id))),
    // The author is the caller's to name: server-core carries no operator
    // identity, and a browser-kept workspace has nobody signed in to record.
    //
    // A continuation keeps the author and the time the proposal was OPENED —
    // decision 8's batch is one request across several calls, so re-stamping
    // here would make them name the last call rather than the proposal.
    author: continuing?.author ?? input.author,
    createdAt: continuing?.createdAt ?? new Date().toISOString(),
    changes: [...args.changes],
  }
  writeProposal(doc, proposal)
  await saveDocumentSnapshot(deps, input.workspaceId, input.documentId, doc)
  // Read back rather than answering with the changes this call contributed.
  // The result is typed as a whole proposal, so it has to be one — and the
  // merge that produced it belongs to the container, so recomputing it here
  // would be a second implementation free to disagree with the first.
  return readProposals(doc).find((stored) => stored.id === proposal.id) ?? proposal
}

export function createBodyEditTool(deps: ServerDeps) {
  return {
    name: 'wb_body_edit' as const,
    description:
      'Replace passages of a markdown document\'s body. Each op quotes the passage it means and declares what that passage said when the edit was written, so a passage that has since moved is still found and one that has since changed is refused by name rather than overwritten. Passages are stored as a PROPOSAL for a person to adopt or dismiss rather than changing the document — that is the default, since nobody watches an agent type; `mode: "apply"` changes the body directly, which is what a surface a person is looking at passes. `proposalId` keeps several calls in one proposal. Either every passage in a call is accepted or none is.',
    inputSchema: bodyEditInputSchema,
    outputSchema: bodyEditOutputSchema,
    execute: (input: BodyEditInput): Promise<BodyEditOutput> =>
      withWorkspaceWrite(deps, input.workspaceId, () => editBody(deps, input)),
  }
}

async function editBody(deps: ServerDeps, input: BodyEditInput): Promise<BodyEditOutput> {
  await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
  const { doc } = await loadDocument(deps, input.workspaceId, input.documentId)

  const kind = readDocumentKind(doc)
  if (kind !== undefined && kind !== 'markdown') {
    throw new DocumentKindMismatchError(
      input.documentId,
      kind,
      'wb_body_edit writes prose into a document body, which a spatial document does not have. Use wb_canvas_edit to change a text node.',
    )
  }

  const body = readMarkdownBody(doc)

  if (input.mode !== 'apply') {
    // The rules are about the proposal, not about the call. A
    // continuation merges into a stored proposal — the container keys
    // changes by id, so an unrefused reuse REPLACES a passage the agent
    // proposed, and a whole-proposal Adopt applies every open change at
    // once, so an overlap spread across two calls corrupts the body just
    // as one inside a single call would. The overlap and the limit
    // checks therefore see what the proposal already holds; the refusal
    // still names a change from THIS call, the one the caller can shrink.
    const continuing = readProposals(doc).find((existing) => existing.id === input.proposalId)
    const existing = placeExisting(body, continuing)
    const placed = placeAll(
      body,
      input.ops,
      new Set(continuing?.changes.map((change) => change.id) ?? []),
    )
    assertDisjoint([...existing, ...placed])
    assertWithinLimit(body, placed, applyPlaced(body, [...existing, ...placed]))
    const proposed = await storeBodyProposal({
      deps,
      input,
      doc,
      changes: placed.map((entry) => entry.change),
    })
    return { documentId: input.documentId, applied: 0, proposed, body }
  }

  const placed = placeAll(body, input.ops)
  assertDisjoint(placed)

  assertAssumptionsHold(placed, body)

  const next = applyPlaced(body, placed)
  assertWithinLimit(body, placed, next)

  writeMarkdownBody(doc, next)
  await saveDocumentSnapshot(deps, input.workspaceId, input.documentId, doc)

  return { documentId: input.documentId, applied: placed.length, body: next }
}
