// Pairing-grant routes (hosted-PWA-first pairing; local-daemon mode only).
//
// POST /api/pairing/grants — called by the daemon-served /pair consent page
//   AFTER the user clicks Approve. Same-origin + Bearer-gated by the
//   surrounding /api/* auth middleware (the R3-served app carries the
//   injected daemon token), so only the daemon's own UI can persist a
//   grant. Persists the origin grant, pushes it into the live allowlist
//   (via the provider wiring in http-server), and mints a single-use
//   PKCE-bound auth code the page carries back to the hosted origin in a
//   `#wb-grant=` fragment.
//
// POST /api/pairing/token — deliberately PUBLIC in route-scope-registry.ts
//   (the one documented exemption from Bearer auth): it authenticates by
//   other means, and it must be reachable by an origin that does not HAVE
//   a token yet. Guards, enumerated:
//   - code exchange: single-use code (60s TTL, burned on any attempt) +
//     PKCE S256 verifier binding the redemption to the transaction that
//     started on the hosted origin;
//   - renewal: the browser-enforced Origin header must match a PERSISTED
//     grant — a cross-site attacker's POST carries its own origin, which
//     has no grant, and a non-browser caller gains nothing here it could
//     not get faster elsewhere (it is not gated by CORS in the first
//     place, and the minted token only works when presented WITH that
//     same Origin header per pairing-session.ts's origin-scoped validate).
//   CSRF shape: the endpoint mints a token only FOR the requesting origin;
//   it never mutates daemon data and never widens any other origin's
//   access, so a forged cross-site POST yields the attacker nothing.
//
// POST /api/pairing/session-assert/challenge, POST /api/pairing/session-assert
//   (ADR-0041 S0-2) — a paired browser session becomes a PERSON's session by
//   asserting a pinned passkey over a daemon-minted challenge. Both require a
//   valid pairing SESSION token as bearer for the request's Origin (the thing
//   being bound), checked against the token store directly in the handler —
//   the surrounding scope middleware alone would also admit the daemon token
//   and, on an open daemon, the `anonymous` grant, neither of which has a
//   session to bind. The challenge is keyed to the SESSION TOKEN that asked
//   (never the origin alone), so another session paired with the same origin
//   cannot spend it. `bind` on a successful assertion is what promotes the
//   token; `profileId` in the response is the MemberProfile that credential
//   maps to (routes/membership.ts), or null when it has none yet.
import { createHash } from 'node:crypto'
import {
  type CreateGrantResponse,
  createGrantRequestSchema,
  type ListCredentialsResponse,
  type ListGrantsResponse,
  listCredentialsResponseSchema,
  listGrantsResponseSchema,
  type PairingTokenResponse,
  type PinnedCredentialSummary,
  pairingTokenRequestSchema,
  pairingTokenResponseSchema,
  pinnedCredentialSummarySchema,
  registerCredentialRequestSchema,
  type SessionAssertChallengeResponse,
  type SessionAssertResponse,
  sessionAssertChallengeResponseSchema,
  sessionAssertRequestSchema,
  sessionAssertResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import { errorBody, invalidRequestBody } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { getLogger } from '../log.js'
import { parseBearerAuthorizationHeader } from '../security/bearer-token.js'
import type { DaemonIdentity } from '../security/daemon-identity.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import type { PairingGrantStore } from '../security/pairing-grant-store.js'
import {
  createSessionChallengeStore,
  type PairingCodeStore,
  type PairingTokenStore,
} from '../security/pairing-session.js'
import { decodeAttestation, verifyWebAuthnAssertion } from '../security/webauthn-assertion.js'
import type {
  PinnedCredential,
  WebAuthnCredentialStore,
} from '../security/webauthn-credential-store.js'
import { verifyWebAuthnRegistration } from '../security/webauthn-registration.js'

const log = getLogger('pairing')

function signTokenResponse(
  identity: DaemonIdentity,
  nonce: string,
  minted: { token: string; expiresAt: string },
  origin: string,
): NonNullable<PairingTokenResponse['identity']> {
  const tokenHash = createHash('sha256').update(minted.token, 'utf8').digest('base64url')
  return {
    alg: identity.alg,
    publicKey: identity.publicKey,
    signature: identity.sign(['wb-token-v1', nonce, origin, tokenHash, minted.expiresAt]),
  }
}

export interface PairingRouterOptions {
  grants: PairingGrantStore
  codes: PairingCodeStore
  tokens: PairingTokenStore
  /** The passkeys paired origins have pinned (ADR-0039). */
  credentials: WebAuthnCredentialStore
  identity: DaemonIdentity
  /** The daemon's MemberProfile store (ADR-0041). Absent in callers with no
   *  membership surface at all, in which case session-assert answers
   *  `profileId: null` unconditionally, same as before this store existed. */
  members?: MemberProfileStore
}

function summarize(pin: PinnedCredential): PinnedCredentialSummary {
  return {
    credentialId: pin.credentialId,
    origin: pin.origin,
    backupEligible: pin.backupEligible,
    createdAt: pin.createdAt,
  }
}

export function createPairingRouter({
  grants,
  codes,
  tokens,
  credentials,
  identity,
  members,
}: PairingRouterOptions) {
  const app = new Hono()

  app.post('/api/pairing/grants', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('invalid_body', 'the request body is not valid JSON'), 400)
    }
    const parsed = createGrantRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    let grant: ReturnType<PairingGrantStore['addGrant']>
    try {
      grant = grants.addGrant(parsed.data.origin)
    } catch {
      return c.json(errorBody('invalid_origin', 'origin must be a valid http(s) URL'), 400)
    }
    const code = codes.mint({ origin: grant.origin, codeChallenge: parsed.data.codeChallenge })
    const response: CreateGrantResponse = { grantId: grant.grantId, origin: grant.origin, code }
    return c.json(response, 201)
  })

  // Grant management (Bearer-gated like grant creation — the settings UI
  // on either the daemon origin or a PAIRED hosted origin may manage them;
  // the pairing-token auth path in createDaemonAuthMiddleware covers the
  // latter). Revocation also kills the origin's live session tokens: a
  // revoked origin keeping a working 24h token would make revoke a lie.
  app.get('/api/pairing/grants', (c) => {
    const response: ListGrantsResponse = listGrantsResponseSchema.parse({
      grants: [...grants.list()],
    })
    return c.json(response, 200)
  })

  app.delete('/api/pairing/grants/:grantId', (c) => {
    const grantId = c.req.param('grantId')
    const revoked = grants.list().find((grant) => grant.grantId === grantId)
    if (revoked === undefined || !grants.revoke(grantId)) {
      return c.json(errorBody('unknown_grant', 'no pairing grant has that id'), 404)
    }
    tokens.revokeOrigin(revoked.origin)
    return c.json({ revoked: true }, 200)
  })

  // Credential pins (ADR-0039). The ORIGIN is the browser-enforced Origin
  // header, never a body field, and it must hold a persisted grant: a pin is
  // the key a later attestation is verified against, so only an origin the
  // user approved may plant one. The relying party a passkey is bound to is
  // that origin's host — the app registers with the default `rp.id`, and a
  // registration against any other party is refused by its rpIdHash.
  app.post('/api/pairing/credentials', async (c) => {
    const originHeader = c.req.header('origin')
    if (!originHeader) {
      return c.json(
        errorBody('origin_required', 'credential registration requires an Origin header'),
        403,
      )
    }
    let origin: URL
    try {
      origin = new URL(originHeader)
    } catch {
      return c.json(errorBody('malformed_origin', 'the Origin header is not a valid origin'), 403)
    }
    if (!grants.origins().includes(origin.origin)) {
      return c.json(errorBody('no_pairing_grant', 'this origin has no pairing grant'), 403)
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('invalid_body', 'the request body is not valid JSON'), 400)
    }
    const parsed = registerCredentialRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    const verdict = verifyWebAuthnRegistration(parsed.data, { rpId: origin.hostname })
    if (!verdict.ok) {
      return c.json({ error: 'registration_rejected', message: verdict.reason }, 400)
    }
    const pin = credentials.register({
      origin: origin.origin,
      rpId: origin.hostname,
      credentialId: parsed.data.credentialId,
      publicKeyJwk: verdict.publicKeyJwk,
      backupEligible: verdict.backupEligible,
      signCount: verdict.signCount,
    })
    return c.json(pinnedCredentialSummarySchema.parse(summarize(pin)), 201)
  })

  app.get('/api/pairing/credentials', (c) => {
    const response: ListCredentialsResponse = listCredentialsResponseSchema.parse({
      credentials: credentials.list().map(summarize),
    })
    return c.json(response, 200)
  })

  // Addressed by credential id alone: an id is 16+ authenticator-random
  // bytes, and a settings UI revoking a pin has the id and not necessarily
  // the origin it was planted from. Also kills any live session already
  // bound to the un-pinned passkey (tokens.revokeBoundTo) — otherwise a
  // session that asserted before the un-pin stays fully authorized for up
  // to its remaining 24h TTL, silently contradicting the revocation.
  app.delete('/api/pairing/credentials/:credentialId', (c) => {
    const credentialId = c.req.param('credentialId')
    const matching = credentials.list().filter((pin) => pin.credentialId === credentialId)
    if (matching.length === 0)
      return c.json(
        errorBody('unknown_credential', 'no passkey is pinned with that credential id'),
        404,
      )
    for (const pin of matching) credentials.revoke(pin.origin, pin.credentialId)
    tokens.revokeBoundTo(
      matching.map((pin) => ({ origin: pin.origin, credentialId: pin.credentialId })),
    )
    return c.json({ revoked: true }, 200)
  })

  app.post('/api/pairing/token', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('invalid_body', 'the request body is not valid JSON'), 400)
    }
    const parsed = pairingTokenRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }

    if (parsed.data.grantType === 'code') {
      const redeemed = await codes.redeem(parsed.data.code, parsed.data.codeVerifier)
      if (redeemed === null) {
        return c.json(errorBody('invalid_code', 'the pairing code is invalid or has expired'), 403)
      }
      const minted = tokens.mint(redeemed.origin)
      const response = pairingTokenResponseSchema.parse({
        ...minted,
        origin: redeemed.origin,
        ...(parsed.data.nonce !== undefined
          ? { identity: signTokenResponse(identity, parsed.data.nonce, minted, redeemed.origin) }
          : {}),
      })
      return c.json(response, 200)
    }

    // Renewal: Origin-header authentication against a persisted grant.
    const originHeader = c.req.header('origin')
    if (!originHeader) {
      return c.json(errorBody('origin_required', 'renewal requires an Origin header'), 403)
    }
    let origin: string
    try {
      origin = new URL(originHeader).origin
    } catch {
      return c.json(errorBody('malformed_origin', 'the Origin header is not a valid origin'), 403)
    }
    if (!grants.origins().includes(origin)) {
      return c.json(errorBody('no_pairing_grant', 'this origin has no pairing grant'), 403)
    }
    const minted = tokens.mint(origin)
    const response = pairingTokenResponseSchema.parse({
      ...minted,
      origin,
      ...(parsed.data.nonce !== undefined
        ? { identity: signTokenResponse(identity, parsed.data.nonce, minted, origin) }
        : {}),
    })
    return c.json(response, 200)
  })

  // In-memory, 60s, one live challenge per session — never persisted, and
  // scoped to this router because nothing else reads it.
  const challenges = createSessionChallengeStore()

  // Authenticates by a valid pairing SESSION token for the requesting
  // Origin, checked against the token store directly rather than the
  // surrounding scope middleware: an `/api/*` route only admits a Bearer
  // that resolves to SOME grant, and both the daemon token and (on an open
  // daemon) `anonymous` resolve fine there — neither has a session to bind.
  function requireSession(c: {
    req: { header(name: string): string | undefined }
  }): { token: string; origin: string } | null {
    const token = parseBearerAuthorizationHeader(c.req.header('authorization'))
    if (token === null) return null
    const originHeader = c.req.header('origin')
    if (!originHeader) return null
    let origin: string
    try {
      origin = new URL(originHeader).origin
    } catch {
      return null
    }
    if (!tokens.validate(token, origin)) return null
    return { token, origin }
  }

  app.post('/api/pairing/session-assert/challenge', (c) => {
    const session = requireSession(c)
    if (session === null) return c.json({ error: 'unauthorized' }, 401)
    const minted = challenges.mint(session.token)
    const response: SessionAssertChallengeResponse =
      sessionAssertChallengeResponseSchema.parse(minted)
    return c.json(response, 200)
  })

  app.post('/api/pairing/session-assert', async (c) => {
    const session = requireSession(c)
    if (session === null) return c.json({ error: 'unauthorized' }, 401)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('invalid_body', 'the request body is not valid JSON'), 400)
    }
    const parsed = sessionAssertRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    const { credentialId } = parsed.data

    const refuse = (error: 'unknown_credential' | 'assertion_rejected', message: string) => {
      log.warning(
        { origin: session.origin, credentialId, reason: message },
        'session assertion refused',
      )
      return c.json({ error, message }, 403)
    }

    const pin = credentials.find(session.origin, credentialId)
    if (pin === null) {
      return refuse('unknown_credential', 'no passkey is pinned for this origin and credential')
    }

    const nonce = challenges.redeem(session.token)
    if (nonce === null) return refuse('assertion_rejected', 'challenge')

    const verdict = verifyWebAuthnAssertion(
      decodeAttestation({ kind: 'webauthn', ...parsed.data }),
      {
        challenge: nonce,
        origin: session.origin,
        rpId: pin.rpId,
        publicKeyJwk: pin.publicKeyJwk,
      },
    )
    if (!verdict.ok) return refuse('assertion_rejected', verdict.reason)
    if (verdict.backupEligible !== pin.backupEligible) {
      return refuse('assertion_rejected', 'backupEligibility')
    }
    if (!credentials.recordSignCount(session.origin, credentialId, verdict.signCount)) {
      return refuse('assertion_rejected', 'signCount')
    }

    const bound = tokens.bind(session.token, { origin: session.origin, credentialId })
    if (bound === null) {
      // The token expired between requireSession's check and here.
      return c.json({ error: 'unauthorized' }, 401)
    }
    const profile = await members?.profileForCredential(session.origin, credentialId)
    const response: SessionAssertResponse = sessionAssertResponseSchema.parse({
      credentialId,
      profileId: profile?.id ?? null,
      boundUntil: bound.expiresAt,
    })
    return c.json(response, 200)
  })

  return app
}
