import {
  type Attestation,
  attestationSchema,
  base64urlSchema,
} from '@kamiazya/whiteboard-server-core/versions/version-entry'
import { z } from 'zod'

// The web app reads the row's evidence through this barrel and never
// through server-core (architecture-map.md: server-core is not one of its
// dependencies). The encoding goes with it: what the browser stores of a
// pinned credential is validated by the same rule the daemon pinned it under.
export type { Attestation }
export { base64urlSchema }

// POST /api/w/:workspaceId/workspace-document/promote — the browser keeper's
// whole record moved into a daemon workspace (ADR-0023), with the person's
// evidence beside it (ADR-0039). JSON rather than the update route's raw
// bytes because the attestation travels WITH the snapshot it vouches for,
// and the daemon verifies before it merges. Deliberately free of node:*.
export const promoteWorkspaceRequestSchema = z
  .object({
    /** The record as `doc.export({ mode: 'snapshot' })`, base64url. */
    snapshot: base64urlSchema,
    /** Present when the browser could ask a passkey; absent is honest, not a failure. */
    attestation: attestationSchema.optional(),
  })
  .strict()
export type PromoteWorkspaceRequest = z.infer<typeof promoteWorkspaceRequestSchema>

export const promoteWorkspaceResponseSchema = z
  .object({
    ok: z.literal(true),
    /** True iff the rows carry a verified attestation. */
    attested: z.boolean(),
    recorded: z.array(z.string()),
    shadowed: z.array(z.string()),
  })
  .strict()
export type PromoteWorkspaceResponse = z.infer<typeof promoteWorkspaceResponseSchema>

/**
 * The bytes both sides hash (SHA-256) to get the WebAuthn challenge a
 * promotion is signed over: a domain tag, the TARGET workspace, and the
 * digest of the exact snapshot bytes being sent. JSON-array encoding gives
 * unambiguous part boundaries, the same convention `buildSignedPayload`
 * uses for the daemon's own signatures. Binding the snapshot's digest is
 * what makes the assertion evidence about THIS content: a replay can only
 * re-promote the same bytes into the same workspace, which is the same
 * idempotent merge.
 */
export function promotionChallengeInput(input: {
  workspaceId: string
  /** SHA-256 of the snapshot bytes, base64url. */
  snapshotDigest: string
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(['wb-promote-v1', input.workspaceId, input.snapshotDigest]),
  )
}
