import { z } from 'zod'

// Single source of truth for the WebCrypto keypair reconnect wire contract —
// POST /api/reconnect-credential (enrollment), POST /api/reconnect-challenge
// (nonce mint), and POST /api/reconnect-session (challenge-response redeem).
// server/routes/reconnect.ts, server/security/web-origin-trust-store.ts, and
// apps/web's reconnect-client.ts all import from here, so the wire contract
// has exactly one definition instead of a server schema and a hand-
// maintained client mirror drifting apart (hence the export through the
// api-contracts barrel). This module must stay browser-safe (no Node
// builtins) — see server/release/web-app-boundary.test.ts.

// Pure length check over a base64url string, deliberately NOT a full decode:
// Buffer is Node-only and atob's browser/Node availability differs across
// runtimes this module is loaded in (browser bundle, jsdom test, Node
// server). Base64 packs 3 bytes into every 4 characters, with the final
// (unpadded, since base64url here never carries `=`) group encoding 1 or 2
// extra bytes for a remainder of 2 or 3 characters respectively; a remainder
// of 1 character can never represent a whole number of bytes and is always
// invalid.
function base64UrlByteLength(value: string): number | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  const remainder = value.length % 4
  if (remainder === 1) return null
  const fullGroups = Math.floor(value.length / 4)
  const remainderBytes = remainder === 0 ? 0 : remainder === 2 ? 1 : 2
  return fullGroups * 3 + remainderBytes
}

function exactByteLengthBase64Url(byteLength: number, fieldLabel: string) {
  return z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      if (base64UrlByteLength(value) !== byteLength) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldLabel} must be base64url encoding of exactly ${byteLength} bytes`,
        })
      }
    })
}

// The client sends this canonical 4-field projection of the exported public
// JWK (dropping ext/key_ops/alg client-side), never the raw
// crypto.subtle.exportKey() output — `.strict()` is what rejects an
// unexpected 'd' (a private-key component) or any other extra field instead
// of a loose z.object silently stripping it.
export const ecP256PublicJwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: exactByteLengthBase64Url(32, 'x'),
    y: exactByteLengthBase64Url(32, 'y'),
  })
  .strict()
export type EcP256PublicJwk = z.infer<typeof ecP256PublicJwkSchema>

export const reconnectCredentialRequestSchema = z.object({
  publicKeyJwk: ecP256PublicJwkSchema,
})
export type ReconnectCredentialRequest = z.infer<typeof reconnectCredentialRequestSchema>

// `.strict()` + the `credentialKind` discriminant: an OLD daemon's
// `{reconnectSecret, expiresInDays}` response has no `credentialKind` field
// and fails this parse, so a new client against an old daemon reports
// enrollment failure and keeps its legacy secret path rather than falsely
// marking the key enrolled.
export const reconnectCredentialResponseSchema = z
  .object({
    credentialKind: z.literal('publicKey'),
    expiresInDays: z.number().positive(),
  })
  .strict()
export type ReconnectCredentialResponse = z.infer<typeof reconnectCredentialResponseSchema>

export const reconnectChallengeResponseSchema = z.object({
  challengeId: z.string().min(1),
  nonce: z.string().min(1),
  expiresInSeconds: z.number().positive(),
})
export type ReconnectChallengeResponse = z.infer<typeof reconnectChallengeResponseSchema>

// P1363 (r||s) signature over the challenge nonce, produced by
// crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, ...) on the client and
// verified with node:crypto's webcrypto.subtle.verify on the daemon — both
// sides speak raw P1363, not DER, so a signature that doesn't decode to
// exactly 64 bytes is rejected before it ever reaches verification.
export const reconnectSessionRequestSchema = z.object({
  challengeId: z.string().min(1),
  signature: exactByteLengthBase64Url(64, 'signature'),
})
export type ReconnectSessionRequest = z.infer<typeof reconnectSessionRequestSchema>

export const reconnectSessionResponseSchema = z.object({
  // Not `.min(1)`: tokenless local-daemon dev mode mounts this router with
  // `daemonToken: ''` (app.ts) and deliberately hands that empty token back
  // rather than refusing the whole reconnect surface — the same "auth is a
  // no-op when no token is configured" behavior every other /api/* route
  // already has.
  token: z.string(),
})
export type ReconnectSessionResponse = z.infer<typeof reconnectSessionResponseSchema>
