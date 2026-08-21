import { z } from 'zod'

// Pairing-token wire contract, shared between the daemon route
// (server/routes/pairing.ts) and the browser-side verifier so the signed
// response shape cannot drift between processes. Deliberately free of any
// node:* import — the browser consumes these schemas directly.

// A caller-random challenge nonce (base64url, 16-32 decoded bytes). When
// present, the token response carries an identity signature binding it —
// see pairingTokenResponseSchema.identity.
export const pairingTokenNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'nonce must be base64url')
  .refine((value) => {
    // Decoded base64url length without Buffer: 4 chars -> 3 bytes, minus padding.
    const bytes = Math.floor((value.length * 3) / 4)
    return bytes >= 16 && bytes <= 32
  }, 'nonce must decode to 16-32 bytes')

export const pairingTokenRequestSchema = z.discriminatedUnion('grantType', [
  z
    .object({
      grantType: z.literal('code'),
      code: z.string().min(1),
      codeVerifier: z.string().min(1),
      nonce: pairingTokenNonceSchema.optional(),
    })
    .strict(),
  z.object({ grantType: z.literal('origin'), nonce: pairingTokenNonceSchema.optional() }).strict(),
])

export const pairingTokenResponseSchema = z
  .object({
    token: z.string(),
    expiresAt: z.string(),
    origin: z.string(),
    // Present iff the request carried a nonce: the daemon's identity plus a
    // signature over ["wb-token-v1", nonce, origin, sha256(token), expiresAt].
    // Binding sha256(token) makes the signature vouch for the very credential
    // being handed over — a squatter cannot splice a real daemon's signature
    // onto its own fake token. Verified browser-side against the key pinned
    // at /pair consent.
    identity: z
      .object({
        alg: z.literal('Ed25519'),
        publicKey: z.string(),
        signature: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type PairingTokenResponse = z.infer<typeof pairingTokenResponseSchema>

// POST /api/pairing/grants — the consent page's grant + PKCE-code mint.
// Shared for the same reason as the token schemas: the daemon route and the
// browser consent page each parse this shape `.strict()`, so a field landing
// on only one side is a runtime throw in the browser while CI stays green.
export const createGrantRequestSchema = z
  .object({
    origin: z.string().min(1),
    codeChallenge: z.string().min(1),
  })
  .strict()

export const createGrantResponseSchema = z
  .object({
    grantId: z.string(),
    origin: z.string(),
    code: z.string(),
  })
  .strict()

export type CreateGrantResponse = z.infer<typeof createGrantResponseSchema>

// GET /api/pairing/grants response — shared so the daemon route and the
// PairedOriginsCard settings UI can never drift apart: a server field
// addition previously had to land in two independent `.strict()` copies at
// once, and a mismatch silently fell the UI to its error state.
export const listGrantsResponseSchema = z
  .object({
    grants: z.array(
      z.object({ grantId: z.string(), origin: z.string(), createdAt: z.string() }).strict(),
    ),
  })
  .strict()

export type ListGrantsResponse = z.infer<typeof listGrantsResponseSchema>
