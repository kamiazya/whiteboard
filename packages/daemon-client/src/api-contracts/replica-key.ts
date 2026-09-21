import { z } from 'zod'

/**
 * The read plane's per-workspace CONTENT key (ADR-0042 decisions 1/3/5,
 * ADR-0043 decision 3). The daemon mints this key once per workspace and
 * hands it to a member's session; the browser derives each document's key
 * from it via `read-plane.ts`'s `deriveDocumentKey` (HKDF, salted, folding in
 * the document's own epoch). A removed member's session never receives this
 * key again — that refusal, not the key's own cryptography, is what makes L1
 * removal (ADR-0042 decision 3) effective for offline reads.
 *
 * Deliberately free of any node:* import — the browser parses this directly.
 *
 * No `epoch` field: the workspace key rotates as a whole through
 * `POST .../replica-key/rotate` (ADR-0042 decision 1, 2026-09-21 addendum),
 * which REPLACES the key+salt outright rather than bumping anything.
 * A single document's own epoch lives beside that document's ciphertext
 * (`read-plane.ts`'s `sealedEnvelopeSchema`), not here — folding a
 * per-document number into a per-workspace response would let one field
 * mean two different rotation scopes. `.strict()` below is what refuses a
 * future caller that tries to thread one through.
 */

export const replicaTierSchema = z.enum(['no-offline', 'offline', 'bounded'])
export type ReplicaTier = z.infer<typeof replicaTierSchema>

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/
const BASE64URL_16_BYTES = /^[A-Za-z0-9_-]{22}$/
/** `keyId` shares the salt's encoding (16 raw bytes, base64url, no padding). */
const BASE64URL_16_BYTES_SCHEMA = z.string().regex(BASE64URL_16_BYTES)

export const replicaKeyResponseSchema = z
  .object({
    /** Base64url, no padding — 32 raw bytes (AES-256-GCM key material). */
    workspaceKey: z.string().regex(BASE64URL_32_BYTES),
    /** Base64url, no padding — 16 raw bytes (the HKDF salt). */
    workspaceKeySalt: z.string().regex(BASE64URL_16_BYTES),
    tier: replicaTierSchema,
    /** Present iff tier === 'bounded': when this lease lapses, the browser
     *  discards the key rather than the daemon revoking anything server-side
     *  — there is no lease table here, only the timestamp. */
    leaseExpiresAt: z.string().datetime().optional(),
    /** A pure function of (workspaceKey, workspaceKeySalt) — never a
     *  separate secret. OPTIONAL rather than required: a daemon and a web
     *  bundle update independently, and a daemon that predates rotation
     *  answers this route with no `keyId` at all. A browser holding a
     *  cached replica compares this against the id it sealed the replica
     *  under; a mismatch means that replica is sealed under a superseded
     *  key and must be dropped and re-pulled, never partially decrypted. */
    keyId: BASE64URL_16_BYTES_SCHEMA.optional(),
  })
  .strict()
  .refine((r) => (r.tier === 'bounded') === (r.leaseExpiresAt !== undefined), {
    message: 'leaseExpiresAt must be present iff tier is bounded',
  })
export type ReplicaKeyResponse = z.infer<typeof replicaKeyResponseSchema>

/**
 * POST /api/workspaces/:workspaceId/replica-key/rotate (ADR-0042 decision 1,
 * 2026-09-21 addendum): replaces the workspace's key+salt outright with a
 * fresh random pair. Gated at `runtime:admin` — the same bar as
 * `replica-tier` above — because rotation is at least as consequential as a
 * tier change: every document key derived from the OLD pair, and every
 * browser replica sealed under it, stops opening the moment this lands.
 *
 * No request body: rotation takes no parameters, so there is nothing to
 * validate on the way in.
 */
export const rotateReplicaKeyResponseSchema = z
  .object({ keyId: BASE64URL_16_BYTES_SCHEMA })
  .strict()
export type RotateReplicaKeyResponse = z.infer<typeof rotateReplicaKeyResponseSchema>

/**
 * PUT /api/workspaces/:workspaceId/replica-tier (ADR-0042 decision 1
 * addendum): sets or clears the workspace's own tier override. Gated at
 * `runtime:admin`, not `workspace:write` — a tier decides whether a copy of
 * a workspace may leave the daemon at all, which is an operator's call
 * rather than something any member may relax for everyone.
 *
 * `tier: null` is the explicit clear, back to the process's
 * `WHITEBOARD_REPLICA_TIER` default — one route and one verb express both
 * set and clear rather than a second endpoint for "unset". `.strict()`
 * refuses a caller that tries to thread a lease TTL or an epoch through,
 * the same guard `replicaKeyResponseSchema` applies for the same reason.
 */
export const setReplicaTierRequestSchema = z.object({ tier: replicaTierSchema.nullable() }).strict()
export type SetReplicaTierRequest = z.infer<typeof setReplicaTierRequestSchema>

/** Echoes both the raw override (`null` once cleared) and what it resolves
 *  to — an operator reads "cleared -> falls back to the default" from one
 *  response instead of a second request. */
export const setReplicaTierResponseSchema = z
  .object({ tier: replicaTierSchema.nullable(), effectiveTier: replicaTierSchema })
  .strict()
export type SetReplicaTierResponse = z.infer<typeof setReplicaTierResponseSchema>
