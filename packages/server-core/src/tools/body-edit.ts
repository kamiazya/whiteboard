import {
  readDocumentKind,
  readMarkdownBody,
  readProposals,
  writeMarkdownBody,
  writeProposal,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  applyBodyChange,
  type BodyProposedChange,
  bodyChangeConflicts,
  bodyReplaceChangeSchema,
  documentIdSchema,
  type Proposal,
  proposalSchema,
  type ResolvedPassage,
  resolveTextAnchor,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { loadDocument, saveDocumentSnapshot } from './document-io.js'
import { DocumentKindMismatchError, PassageNotApplicableError } from './errors.js'

/**
 * One proposed passage as a CALLER sends it: the model's own `body.replace`
 * minus `status`, which is a verdict the document keeps rather than something
 * an agent declares. Omitted from the model schema rather than restated, so
 * the wire shape and the shape a person's card decides on cannot drift.
 */
export const bodyEditOpSchema = bodyReplaceChangeSchema.omit({ status: true })
export type BodyEditOp = z.infer<typeof bodyEditOpSchema>

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
    ops: z.array(bodyEditOpSchema).min(1, 'a body edit carries at least one passage'),
  })
  .strict()
export type BodyEditInput = z.infer<typeof bodyEditInputSchema>

export const bodyEditOutputSchema = z
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

/** A change paired with where the body currently holds its passage. */
interface PlacedChange {
  readonly change: BodyProposedChange
  readonly at: ResolvedPassage
}

/**
 * Every op placed against `body`, or a refusal naming the first that cannot
 * be placed.
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
): PlacedChange[] {
  const seen = new Set<string>(taken)
  const placed: PlacedChange[] = []
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
function placeExisting(body: string, proposal: Proposal | undefined): PlacedChange[] {
  if (proposal === undefined) return []
  const placed: PlacedChange[] = []
  for (const change of proposal.changes) {
    if (change.op !== 'body.replace' || change.status !== 'open') continue
    const resolved = resolveTextAnchor(body, change.anchor)
    if (resolved.kind !== 'placed') continue
    placed.push({ change, at: resolved })
  }
  return placed
}

/**
 * Refuses a batch whose passages reach into one another.
 *
 * Placement reads ONE body, and applying back-to-front is what keeps each
 * op's offsets valid — but that equivalence holds only while the ranges are
 * disjoint. Two overlapping passages are each applicable against the body the
 * caller saw and produce, together, a result that is neither: 'abc'→'X' and
 * 'bcd'→'Y' over `abcdef` persist `Xf`, not `Xdef` and not `aYef`. Nothing
 * downstream could tell that apart from an edit somebody meant.
 *
 * Checked when proposing too, since a whole-proposal Adopt applies exactly
 * this set and would corrupt the body the same way — later, and further from
 * the call that caused it.
 *
 * Ranges that merely TOUCH are fine — `[0,3)` and `[3,6)` share no character,
 * so neither rewrites text the other was placed on. Hence a strict overlap
 * test rather than a `<=`.
 *
 * A placed range is never empty here: `resolveTextAnchor` places a passage by
 * finding `quote.exact`, which the schema requires to be at least one
 * character, so the degenerate zero-length case this test would miss cannot
 * arise.
 */
function assertDisjoint(placed: readonly PlacedChange[]): void {
  const byStart = [...placed].sort((a, b) => a.at.start - b.at.start)
  for (let i = 1; i < byStart.length; i += 1) {
    const previous = byStart[i - 1] as PlacedChange
    const current = byStart[i] as PlacedChange
    if (current.at.start < previous.at.end) {
      throw new PassageNotApplicableError(
        current.change.id,
        `its passage [${current.at.start}, ${current.at.end}) overlaps ${previous.change.id}'s [${previous.at.start}, ${previous.at.end}) — applying both would write text neither one proposed`,
      )
    }
  }
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
function assertAssumptionsHold(placed: readonly PlacedChange[], body: string): void {
  for (const { change, at } of placed) {
    if (!bodyChangeConflicts(change, body, at)) continue
    throw new PassageNotApplicableError(
      change.id,
      `the body now reads ${JSON.stringify(body.slice(at.start, at.end))} there, not ${JSON.stringify(change.assumed)}`,
    )
  }
}

/** The first `p<n>` no proposal on this document already holds. */
function mintProposalId(taken: ReadonlySet<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `p${i}`
    if (!taken.has(candidate)) return candidate
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
  readonly workspaceId: string
  readonly documentId: string
  readonly proposalId?: string
  readonly doc: LoroDoc
  readonly changes: readonly BodyProposedChange[]
}): Promise<Proposal> {
  const open = readProposals(args.doc)
  const continuing = open.find((existing) => existing.id === args.proposalId)
  const proposal: Proposal = {
    id: args.proposalId ?? mintProposalId(new Set(open.map((existing) => existing.id))),
    // No author: server-core carries no operator identity, and a
    // browser-kept workspace has nobody signed in to record.
    //
    // A continuation keeps the time the proposal was OPENED — decision 8's
    // batch is one request across several calls, so re-stamping here would
    // make `createdAt` name the last call rather than the proposal.
    createdAt: continuing?.createdAt ?? new Date().toISOString(),
    changes: [...args.changes],
  }
  writeProposal(args.doc, proposal)
  await saveDocumentSnapshot(args.deps, args.workspaceId, args.documentId, args.doc)
  // Read back rather than answering with the changes this call contributed.
  // The result is typed as a whole proposal, so it has to be one — and the
  // merge that produced it belongs to the container, so recomputing it here
  // would be a second implementation free to disagree with the first.
  return readProposals(args.doc).find((stored) => stored.id === proposal.id) ?? proposal
}

export function createBodyEditTool(deps: ServerDeps) {
  return {
    name: 'wb_body_edit' as const,
    description:
      'Replace passages of a markdown document\'s body. Each op quotes the passage it means and declares what that passage said when the edit was written, so a passage that has since moved is still found and one that has since changed is refused by name rather than overwritten. Passages are stored as a PROPOSAL for a person to adopt or dismiss rather than changing the document — that is the default, since nobody watches an agent type; `mode: "apply"` changes the body directly, which is what a surface a person is looking at passes. `proposalId` keeps several calls in one proposal. Either every passage in a call is accepted or none is.',
    inputSchema: bodyEditInputSchema,
    outputSchema: bodyEditOutputSchema,
    execute: async (input: BodyEditInput): Promise<BodyEditOutput> => {
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
        // as one inside a single call would. Both checks therefore see what
        // the proposal already holds.
        const continuing = readProposals(doc).find((existing) => existing.id === input.proposalId)
        const existing = placeExisting(body, continuing)
        const placed = placeAll(
          body,
          input.ops,
          new Set(continuing?.changes.map((change) => change.id) ?? []),
        )
        assertDisjoint([...existing, ...placed])
        const proposed = await storeBodyProposal({
          deps,
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          proposalId: input.proposalId,
          doc,
          changes: placed.map((entry) => entry.change),
        })
        return { documentId: input.documentId, applied: 0, proposed, body }
      }

      const placed = placeAll(body, input.ops)
      assertDisjoint(placed)

      assertAssumptionsHold(placed, body)

      // Applied from the LAST passage backwards, so an earlier op's
      // replacement never shifts the offsets a later one was placed at.
      // Placement read one body; applying in document order would make every
      // op after the first act on offsets taken from a body that no longer
      // exists.
      const next = [...placed]
        .sort((a, b) => b.at.start - a.at.start)
        .reduce((text, { change, at }) => applyBodyChange(text, change, at), body)

      writeMarkdownBody(doc, next)
      await saveDocumentSnapshot(deps, input.workspaceId, input.documentId, doc)

      return { documentId: input.documentId, applied: placed.length, body: next }
    },
  }
}
