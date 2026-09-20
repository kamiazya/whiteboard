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
 * No `epoch` field: the workspace key rotates as a whole only through a
 * (not yet built) rotation route. A single document's own epoch lives beside
 * that document's ciphertext (`read-plane.ts`'s `sealedEnvelopeSchema`), not
 * here — folding a per-document number into a per-workspace response would
 * let one field mean two different rotation scopes. `.strict()` below is
 * what refuses a future caller that tries to thread one through.
 */

export const replicaTierSchema = z.enum(['no-offline', 'offline', 'bounded'])
export type ReplicaTier = z.infer<typeof replicaTierSchema>

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/
const BASE64URL_16_BYTES = /^[A-Za-z0-9_-]{22}$/

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
  })
  .strict()
  .refine((r) => (r.tier === 'bounded') === (r.leaseExpiresAt !== undefined), {
    message: 'leaseExpiresAt must be present iff tier is bounded',
  })
export type ReplicaKeyResponse = z.infer<typeof replicaKeyResponseSchema>
