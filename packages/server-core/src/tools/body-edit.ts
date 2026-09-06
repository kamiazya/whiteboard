import {
  readDocumentKind,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  applyBodyChange,
  type BodyProposedChange,
  bodyChangeConflicts,
  bodyReplaceChangeSchema,
  documentIdSchema,
  type ResolvedPassage,
  resolveTextAnchor,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
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
     * `apply` only for now. The word is here rather than added later because
     * it is the SAME word `wb_canvas_edit` spends on apply-vs-propose, and a
     * tool that shipped without it would have to change meaning to gain it.
     * Prose gets the content-proposes default in its own increment.
     */
    mode: z.literal('apply'),
    ops: z.array(bodyEditOpSchema).min(1, 'a body edit carries at least one passage'),
  })
  .strict()
export type BodyEditInput = z.infer<typeof bodyEditInputSchema>

export const bodyEditOutputSchema = z
  .object({
    documentId: documentIdSchema,
    applied: z.number().int().nonnegative(),
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
 * Every op placed against `body`, or the first one that cannot be.
 *
 * Placement happens for the WHOLE batch before anything is written, and one
 * unplaceable op refuses all of them. A partial apply would leave the caller
 * holding a document that is neither what it had nor what it asked for, and
 * nothing in the result could say which passages landed in a way the next
 * call could act on — the same reason `wb_canvas_edit` is all-or-nothing.
 */
function placeAll(body: string, ops: readonly BodyEditOp[]): PlacedChange[] {
  const placed: PlacedChange[] = []
  for (const op of ops) {
    const change: BodyProposedChange = { ...op, status: 'open' }
    const resolved = resolveTextAnchor(body, op.anchor)
    const at = resolved.kind === 'placed' ? resolved : undefined
    if (bodyChangeConflicts(change, body, at)) {
      throw new PassageNotApplicableError(
        op.id,
        at === undefined
          ? 'its passage is no longer in the body'
          : `the body now reads ${JSON.stringify(body.slice(at.start, at.end))} there, not ${JSON.stringify(op.assumed)}`,
      )
    }
    placed.push({ change, at: at as ResolvedPassage })
  }
  assertDisjoint(placed)
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

export function createBodyEditTool(deps: ServerDeps) {
  return {
    name: 'wb_body_edit' as const,
    description:
      "Replace passages of a markdown document's body. Each op quotes the passage it means and declares what that passage said when the edit was written, so a passage that has since moved is still found and one that has since changed is refused by name rather than overwritten. Either every passage applies or none does.",
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
      const placed = placeAll(body, input.ops)

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
