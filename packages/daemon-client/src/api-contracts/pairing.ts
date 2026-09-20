// The version-entry MODULE, never server-core's root: this file is on the
// web app's critical path (the pairing hook and the identity pin import it
// statically), and a root import there is retained whole by the bundler —
// measured at 144.5 KB → 413.8 KB gzip, loro's WASM included. See
// server-core-root-imports.test.ts.
import {
  attestationSchema,
  base64urlSchema,
} from '@kamiazya/whiteboard-server-core/versions/version-entry'
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

// POST /api/pairing/credentials — a paired origin PINS a passkey's public key
// on the daemon (ADR-0039). The three fields are what `navigator.credentials
// .create()` hands the page, raw and base64url: the credential id, the
// public key as SPKI (`response.getPublicKey()`), and the registration's
// `authenticatorData` (`response.getAuthenticatorData()`), which is where
// the daemon reads the relying party, the attested credential id and the
// backup-eligibility flag from. The origin is never in the body: the
// browser-enforced Origin header names it, and a body field would be a
// caller's claim about which origin it is.
export const registerCredentialRequestSchema = z
  .object({
    credentialId: base64urlSchema,
    publicKey: base64urlSchema,
    authenticatorData: base64urlSchema,
  })
  .strict()
export type RegisterCredentialRequest = z.infer<typeof registerCredentialRequestSchema>

// What a settings UI needs to name a pin, and what POST answers: never the
// key itself.
export const pinnedCredentialSummarySchema = z
  .object({
    credentialId: z.string().min(1),
    origin: z.string().min(1),
    backupEligible: z.boolean(),
    createdAt: z.string(),
  })
  .strict()
export type PinnedCredentialSummary = z.infer<typeof pinnedCredentialSummarySchema>

export const listCredentialsResponseSchema = z
  .object({ credentials: z.array(pinnedCredentialSummarySchema) })
  .strict()
export type ListCredentialsResponse = z.infer<typeof listCredentialsResponseSchema>

// GET /api/pairing/session-assert/challenge — mints the nonce a paired
// session signs to become a PERSON's session (a passkey-bound session,
// ADR-0041). 43 chars is the canonical unpadded base64url length of exactly
// 32 decoded bytes.
export const sessionAssertChallengeResponseSchema = z
  .object({
    challenge: base64urlSchema.length(43, '32 decoded bytes'),
    expiresAt: z.string(),
  })
  .strict()
export type SessionAssertChallengeResponse = z.infer<typeof sessionAssertChallengeResponseSchema>

// POST /api/pairing/session-assert — the raw WebAuthn assertion over the
// minted challenge. Reuses the version row's own attestation shape (minus
// its `kind` discriminator) rather than a hand-written mirror, so a field
// added to one travels to both at once. The origin is never in the body:
// the browser-enforced Origin header names it, same reasoning as
// registerCredentialRequestSchema.
export const sessionAssertRequestSchema = attestationSchema.omit({ kind: true }).strict()
export type SessionAssertRequest = z.infer<typeof sessionAssertRequestSchema>

// What a successful assertion hands back: the credential it verified
// against, the person it belongs to (null when the passkey is pinned but no
// MemberProfile claims it yet), and boundUntil — the pairing token's own
// expiry, since a binding never outlives its session.
export const sessionAssertResponseSchema = z
  .object({
    credentialId: z.string().min(1),
    profileId: z.string().min(1).nullable(),
    boundUntil: z.string(),
  })
  .strict()
export type SessionAssertResponse = z.infer<typeof sessionAssertResponseSchema>
