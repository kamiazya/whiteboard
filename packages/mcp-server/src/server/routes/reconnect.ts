// Silent-reconnect surface: lets a previously-paired web origin get a fresh
// daemon Bearer token back after a page reload without a confirmation
// dialog, by proving POSSESSION of an enrolled ECDSA P-256 keypair (WebCrypto
// challenge-response) rather than by presenting the Origin header alone (see
// web-origin-trust-store.ts for why Origin alone would weaken the existing
// cross-user boundary). A legacy Bearer-secret path is accepted for a grace
// period while older enrolled clients migrate to the keypair flow — see
// verifyLegacySecret's docs.
//
// Three routes:
//   POST /api/reconnect-credential — enrollment. Runs behind the app-level
//     daemon-token auth middleware (app.ts), so only a caller who already
//     holds the daemon token (e.g. right after a #wb= pairing) can enroll a
//     public key for its own Origin.
//   POST /api/reconnect-challenge — mints a one-time nonce challenge.
//     Deliberately public: the caller has no daemon token by definition, and
//     the mint must not depend on whether the origin has an enrolled
//     credential (declared, this route's own scope entry in
//     route-scope-registry.ts) — refusing unenrolled origins would make this
//     route an enrollment oracle.
//   POST /api/reconnect-session — redeems a signed challenge (or, during the
//     grace period, a legacy secret) for a daemon token. Deliberately the
//     ONLY unauthenticated-by-daemon-token entry under /api/* besides the
//     challenge mint above (declared `public` in route-scope-registry.ts)
//     because its whole purpose is to hand back a daemon token to a caller
//     who no longer has one. Its own gates (Origin admission + challenge
//     signature or legacy secret possession + non-expired trust record) are
//     what stand in for the app-level auth this route is carved out of.

import { Hono } from 'hono'
import {
  ecP256PublicJwkSchema,
  type ReconnectChallengeResponse,
  type ReconnectCredentialResponse,
  type ReconnectSessionResponse,
  reconnectChallengeResponseSchema,
  reconnectCredentialResponseSchema,
  reconnectSessionRequestSchema,
  reconnectSessionResponseSchema,
} from '../../shared/api-contracts/reconnect.js'
import { isLoopbackHostname, normalizeOriginHostname } from '../security/cors-loopback.js'
import type { ReconnectChallengeStore } from '../security/reconnect-challenge-store.js'
import { isAllowedWebOrigin } from '../security/web-origin-allowlist.js'
import { TRUST_TTL_MS, type WebOriginTrustStore } from '../security/web-origin-trust-store.js'
import { parseBearerAuthorizationHeader } from './auth.js'

export {
  type ReconnectChallengeResponse,
  type ReconnectCredentialResponse,
  type ReconnectSessionResponse,
  reconnectChallengeResponseSchema,
  reconnectCredentialResponseSchema,
  reconnectSessionResponseSchema,
}

// Derived from the store's actually-enforced TTL rather than a second
// hardcoded constant, so the value reported to clients can never drift from
// the value the trust store enforces.
const TRUST_TTL_DAYS = TRUST_TTL_MS / (24 * 60 * 60 * 1000)

export interface ReconnectRouterOptions {
  trustStore: WebOriginTrustStore
  challengeStore: ReconnectChallengeStore
  // Exact-match hosted origins currently admitted, mirroring
  // LocalDaemonAppOptions.allowedWebOrigins. Loopback origins are always
  // admitted in addition to this list (same carve-out as the /api/* CORS
  // middleware) — a hosted origin removed from this list is refused here
  // even if a still-valid trust record exists for it (the delisting path).
  allowedWebOrigins: readonly string[]
  daemonToken: string
}

// Canonicalizes an Origin header the same way WHATWG URL parsing already
// normalizes case and an explicit default port for every other origin
// comparison in this codebase (origin-pattern.ts's matchOrigin relies on the
// same normalization). Returns null for anything unparseable.
function canonicalizeOrigin(originHeader: string | undefined): string | null {
  if (!originHeader) return null
  try {
    return new URL(originHeader).origin
  } catch {
    return null
  }
}

function isAdmittedOrigin(origin: string, allowedWebOrigins: readonly string[]): boolean {
  const hostname = normalizeOriginHostname(origin)
  if (hostname !== null && isLoopbackHostname(hostname)) return true
  return isAllowedWebOrigin(origin, allowedWebOrigins)
}

// Returns the canonicalized Origin iff it is admitted (loopback or explicitly
// allowlisted), otherwise null — every reconnect route gates on this first.
function admittedOrigin(
  originHeader: string | undefined,
  allowedWebOrigins: readonly string[],
): string | null {
  const origin = canonicalizeOrigin(originHeader)
  if (origin === null || !isAdmittedOrigin(origin, allowedWebOrigins)) return null
  return origin
}

export function createReconnectRouter(options: ReconnectRouterOptions) {
  const app = new Hono()

  app.post('/api/reconnect-credential', async (c) => {
    const canonicalOrigin = admittedOrigin(c.req.header('origin'), options.allowedWebOrigins)
    if (canonicalOrigin === null) {
      return c.json({ error: 'forbidden_origin' }, 403)
    }
    const rawBody = await c.req.json().catch(() => null)
    const parsedBody = ecP256PublicJwkSchema.safeParse(
      (rawBody as { publicKeyJwk?: unknown } | null)?.publicKeyJwk,
    )
    if (!parsedBody.success) {
      return c.json({ error: 'invalid_public_key' }, 400)
    }
    await options.trustStore.enrollPublicKey(canonicalOrigin, parsedBody.data)
    return c.json(
      reconnectCredentialResponseSchema.parse({
        credentialKind: 'publicKey',
        expiresInDays: TRUST_TTL_DAYS,
      } satisfies ReconnectCredentialResponse),
    )
  })

  app.post('/api/reconnect-challenge', (c) => {
    const canonicalOrigin = admittedOrigin(c.req.header('origin'), options.allowedWebOrigins)
    if (canonicalOrigin === null) {
      return c.json({ error: 'forbidden_origin' }, 403)
    }
    const minted = options.challengeStore.mintChallenge(canonicalOrigin)
    if (minted === null) {
      return c.json({ error: 'too_many_pending_challenges' }, 429)
    }
    return c.json(
      reconnectChallengeResponseSchema.parse({
        challengeId: minted.challengeId,
        nonce: minted.nonce,
        expiresInSeconds: minted.expiresIn,
      } satisfies ReconnectChallengeResponse),
    )
  })

  app.post('/api/reconnect-session', async (c) => {
    const canonicalOrigin = admittedOrigin(c.req.header('origin'), options.allowedWebOrigins)
    if (canonicalOrigin === null) {
      return c.json({ error: 'forbidden_origin' }, 403)
    }

    // Legacy grace path: a caller presenting a Bearer secret is verified
    // against the record's secretHash, no rotation. Checked before the
    // signed-challenge body so an old client (which never sends a JSON
    // body) is not forced through JSON parsing first.
    const legacySecret = parseBearerAuthorizationHeader(c.req.header('authorization'))
    if (legacySecret !== null) {
      const verified = await options.trustStore.verifyLegacySecret(canonicalOrigin, legacySecret)
      if (!verified) {
        return c.json({ error: 'unauthorized' }, 403)
      }
      return c.json(
        reconnectSessionResponseSchema.parse({
          token: options.daemonToken,
        } satisfies ReconnectSessionResponse),
      )
    }

    const rawBody = await c.req.json().catch(() => null)
    const parsedBody = reconnectSessionRequestSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const { challengeId, signature } = parsedBody.data
    const nonce = options.challengeStore.redeemChallenge(challengeId, canonicalOrigin)
    if (nonce === null) {
      return c.json({ error: 'unauthorized' }, 403)
    }
    const verified = await options.trustStore.verifySignedChallenge(
      canonicalOrigin,
      nonce,
      signature,
    )
    if (!verified) {
      return c.json({ error: 'unauthorized' }, 403)
    }
    return c.json(
      reconnectSessionResponseSchema.parse({
        token: options.daemonToken,
      } satisfies ReconnectSessionResponse),
    )
  })

  return app
}
