import {
  base64urlSchema,
  PROMOTE_MAX_TRASH,
  PROMOTE_MAX_VERSIONS,
  promotedTrashBytesRequestSchema,
  promotedVersionRequestSchema,
} from '@kamiazya/whiteboard-server-core/versions/version-entry'
import { z } from 'zod'
import { MAX_FILE_UPLOAD_BYTES } from './files.js'

// The carried planes' shapes are server-core's, where the operation that
// judges them reads them, and are published here for the sender: the web app
// never imports server-core (architecture-map.md).
export type {
  PromotedTrashBytes,
  PromotedVersion,
} from '@kamiazya/whiteboard-server-core/versions/version-entry'
export { PROMOTE_MAX_TRASH, PROMOTE_MAX_VERSIONS }

/**
 * The most a promote request body may carry: the content ceiling, which a
 * record is held to, base64url-inflated by 4/3 inside JSON and rounded up to
 * 3/2. Here rather than in the route so the sender can fit what it carries
 * beside the record under the same number the daemon refuses past.
 */
export const PROMOTE_REQUEST_LIMIT_BYTES = (MAX_FILE_UPLOAD_BYTES * 3) / 2

// POST /api/w/:workspaceId/workspace-document/promote — the browser keeper's
// whole record moved into a daemon workspace (ADR-0023). JSON rather than
// the update route's raw bytes because the carried planes travel WITH the
// snapshot they belong to. Deliberately free of node:*.
//
// The planes the record only POINTS at travel beside it — each trash entry's
// evacuated bytes and the saved version rows — so one request, inside the one
// body ceiling, carries everything the move removes from the browser. What
// does not fit is left out by the sender, which then keeps its copy.
export const promoteWorkspaceRequestSchema = z
  .object({
    /** The record as `doc.export({ mode: 'snapshot' })`, base64url. */
    snapshot: base64urlSchema,
    // Counted before any row is judged, so a request cannot repeat rows
    // until the body ceiling; the daemon answers past either 413
    // `promote_too_many_carried`, and the sender leaves the rest behind.
    // The same code answers versions whose states cost more to judge than
    // server-core's PROMOTE_MAX_JUDGED_ELEMENTS, which no row count bounds.
    trash: z.array(promotedTrashBytesRequestSchema).max(PROMOTE_MAX_TRASH).optional(),
    versions: z.array(promotedVersionRequestSchema).max(PROMOTE_MAX_VERSIONS).optional(),
  })
  .strict()
export type PromoteWorkspaceRequest = z.infer<typeof promoteWorkspaceRequestSchema>

/**
 * The refusal of carried versions that would cost more to judge than one move
 * allows (server-core's PROMOTE_MAX_JUDGED_ELEMENTS): 413, the same code as a
 * count past the cap, plus the budget as `limit` — in elements, the unit
 * loro-adapter's `stateElementCount` counts — so the sender can carry the
 * newest versions that fit and move again. A count refusal carries no
 * `limit`, so this schema tells the two apart.
 */
export const promoteJudgedBudgetRefusalSchema = z.object({
  error: z.literal('promote_too_many_carried'),
  message: z.string().min(1),
  limit: z.number().int().positive(),
})
export type PromoteJudgedBudgetRefusal = z.infer<typeof promoteJudgedBudgetRefusalSchema>

export const promoteWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  recorded: z.array(z.string()),
  shadowed: z.array(z.string()),
  /**
   * The trash entries whose bytes the daemon holds after the move, read back
   * from its blob store rather than echoed from the request. Absent reads as
   * none held — the answer that keeps the sender's copy, which is the safe
   * one for a keeper that does not say.
   */
  trashStored: z.array(z.string()).default([]),
  /**
   * The carried version ids the daemon's history took in for this workspace,
   * read back likewise. An automatic one its own cap then retires still
   * counts: it arrived, and went the way one of the daemon's own would.
   */
  versionsKept: z.array(z.string()).default([]),
})
export type PromoteWorkspaceResponse = z.infer<typeof promoteWorkspaceResponseSchema>
