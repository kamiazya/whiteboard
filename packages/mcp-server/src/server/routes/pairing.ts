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
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  type PairingTokenResponse,
  pairingTokenRequestSchema,
} from '../../shared/api-contracts/pairing.js'
import type { DaemonIdentity } from '../security/daemon-identity.js'
import type { PairingGrantStore } from '../security/pairing-grant-store.js'
import type { PairingCodeStore, PairingTokenStore } from '../security/pairing-session.js'

const createGrantRequestSchema = z
  .object({
    origin: z.string().min(1),
    codeChallenge: z.string().min(1),
  })
  .strict()

const createGrantResponseSchema = z
  .object({
    grantId: z.string(),
    origin: z.string(),
    code: z.string(),
  })
  .strict()
type CreateGrantResponse = z.infer<typeof createGrantResponseSchema>

const listGrantsResponseSchema = z
  .object({
    grants: z.array(
      z.object({ grantId: z.string(), origin: z.string(), createdAt: z.string() }).strict(),
    ),
  })
  .strict()
type ListGrantsResponse = z.infer<typeof listGrantsResponseSchema>

type TokenResponse = PairingTokenResponse

function signTokenResponse(
  identity: DaemonIdentity,
  nonce: string,
  minted: { token: string; expiresAt: string },
  origin: string,
): NonNullable<TokenResponse['identity']> {
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
  identity: DaemonIdentity
}

export function createPairingRouter({ grants, codes, tokens, identity }: PairingRouterOptions) {
  const app = new Hono()

  app.post('/api/pairing/grants', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const parsed = createGrantRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    let grant: ReturnType<PairingGrantStore['addGrant']>
    try {
      grant = grants.addGrant(parsed.data.origin)
    } catch {
      return c.json({ error: 'origin must be a valid http(s) URL' }, 400)
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
    const response: ListGrantsResponse = { grants: [...grants.list()] }
    return c.json(response, 200)
  })

  app.delete('/api/pairing/grants/:grantId', (c) => {
    const grantId = c.req.param('grantId')
    const revoked = grants.list().find((grant) => grant.grantId === grantId)
    if (revoked === undefined || !grants.revoke(grantId)) {
      return c.json({ error: 'unknown grant' }, 404)
    }
    tokens.revokeOrigin(revoked.origin)
    return c.json({ revoked: true }, 200)
  })

  app.post('/api/pairing/token', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const parsed = pairingTokenRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }

    if (parsed.data.grantType === 'code') {
      const redeemed = await codes.redeem(parsed.data.code, parsed.data.codeVerifier)
      if (redeemed === null) {
        return c.json({ error: 'invalid or expired code' }, 403)
      }
      const minted = tokens.mint(redeemed.origin)
      const response: TokenResponse = {
        ...minted,
        origin: redeemed.origin,
        ...(parsed.data.nonce !== undefined
          ? { identity: signTokenResponse(identity, parsed.data.nonce, minted, redeemed.origin) }
          : {}),
      }
      return c.json(response, 200)
    }

    // Renewal: Origin-header authentication against a persisted grant.
    const originHeader = c.req.header('origin')
    if (!originHeader) {
      return c.json({ error: 'renewal requires an Origin header' }, 403)
    }
    let origin: string
    try {
      origin = new URL(originHeader).origin
    } catch {
      return c.json({ error: 'malformed Origin header' }, 403)
    }
    if (!grants.origins().includes(origin)) {
      return c.json({ error: 'origin has no pairing grant' }, 403)
    }
    const minted = tokens.mint(origin)
    const response: TokenResponse = {
      ...minted,
      origin,
      ...(parsed.data.nonce !== undefined
        ? { identity: signTokenResponse(identity, parsed.data.nonce, minted, origin) }
        : {}),
    }
    return c.json(response, 200)
  })

  return app
}
