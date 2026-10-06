import { versionLabelSchema, WORKSPACE_ID_PATTERN } from '@kamiazya/whiteboard-model'
import {
  type Attestation,
  attestationSchema,
  base64urlSchema,
  requestOperatorSchema,
} from '@kamiazya/whiteboard-server-core/versions/version-entry'
import { z } from 'zod'
import { MAX_FILE_UPLOAD_BYTES } from './files.js'

// The web app reads the row's evidence through this barrel and never
// through server-core (architecture-map.md: server-core is not one of its
// dependencies). The encoding goes with it: what the browser stores of a
// pinned credential is validated by the same rule the daemon pinned it under.
export type { Attestation }
export { base64urlSchema }

/**
 * The evacuated bytes one of the record's trash entries names. The record
 * carries only the entry and its digest; the bytes live in the browser's blob
 * store, and without them the daemon lists the entry but cannot restore it.
 * The daemon stores them only when they hash to the digest the entry names.
 */
const promotedTrashBytesSchema = z
  .object({
    documentId: z.string().min(1),
    bytes: base64urlSchema,
  })
  .strict()
export type PromotedTrashBytes = z.infer<typeof promotedTrashBytesSchema>

/** A version id the daemon can key a row by — the character class its validator admits. */
const promotedVersionIdSchema = z.string().max(64).regex(WORKSPACE_ID_PATTERN)

/**
 * One saved version of a promoted document, as the browser keeper recorded
 * it. A version is a frontier of the workspace record, and the merge keeps
 * every op's peer and counter, so the frontier names the same point in the
 * daemon's record; the daemon checks it out of the incoming record before it
 * merges and derives the element count and content digest from that state
 * itself rather than trusting a figure.
 *
 * The operator is the request form — no `actor`: the device a row names is
 * one the keeper can back with a key, which a carried row cannot.
 */
const promotedVersionSchema = z
  .object({
    id: promotedVersionIdSchema,
    documentId: z.string().min(1),
    /** When the browser saved it, epoch milliseconds — kept, so the history reads in order. */
    createdAt: z.number().int().nonnegative(),
    auto: z.boolean(),
    label: versionLabelSchema.optional(),
    operator: requestOperatorSchema.optional(),
    restoredFrom: promotedVersionIdSchema.optional(),
    /** `encodeFrontiers` of the record at the version, base64url. */
    frontiers: base64urlSchema,
  })
  .strict()
export type PromotedVersion = z.infer<typeof promotedVersionSchema>

/**
 * The most a promote request body may carry: the content ceiling, which a
 * record is held to, base64url-inflated by 4/3 inside JSON and rounded up to
 * 3/2. Here rather than in the route so the sender can fit what it carries
 * beside the record under the same number the daemon refuses past.
 */
export const PROMOTE_REQUEST_LIMIT_BYTES = (MAX_FILE_UPLOAD_BYTES * 3) / 2

// POST /api/w/:workspaceId/workspace-document/promote — the browser keeper's
// whole record moved into a daemon workspace (ADR-0023), with the person's
// evidence beside it (ADR-0039). JSON rather than the update route's raw
// bytes because the attestation travels WITH the snapshot it vouches for,
// and the daemon verifies before it merges. Deliberately free of node:*.
//
// The planes the record only POINTS at travel beside it — each trash entry's
// evacuated bytes and the saved version rows — so one request, inside the one
// body ceiling, carries everything the move removes from the browser. What
// does not fit is left out by the sender, which then keeps its copy.
export const promoteWorkspaceRequestSchema = z
  .object({
    /** The record as `doc.export({ mode: 'snapshot' })`, base64url. */
    snapshot: base64urlSchema,
    /** Present when the browser could ask a passkey; absent is honest, not a failure. */
    attestation: attestationSchema.optional(),
    trash: z.array(promotedTrashBytesSchema).optional(),
    versions: z.array(promotedVersionSchema).optional(),
  })
  .strict()
export type PromoteWorkspaceRequest = z.infer<typeof promoteWorkspaceRequestSchema>

export const promoteWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  /** True iff the rows carry a verified attestation. */
  attested: z.boolean(),
  recorded: z.array(z.string()),
  shadowed: z.array(z.string()),
  /**
   * The trash entries whose bytes the daemon holds after the move, read back
   * from its blob store rather than echoed from the request. Absent reads as
   * none held — the answer that keeps the sender's copy, which is the safe
   * one for a keeper that does not say.
   */
  trashStored: z.array(z.string()).default([]),
  /** The carried version ids the daemon's history holds for this workspace, read back likewise. */
  versionsKept: z.array(z.string()).default([]),
})
export type PromoteWorkspaceResponse = z.infer<typeof promoteWorkspaceResponseSchema>
