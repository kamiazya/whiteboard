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
import { Hono } from 'hono'
import { z } from 'zod'
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

const tokenRequestSchema = z.discriminatedUnion('grantType', [
  z
    .object({
      grantType: z.literal('code'),
      code: z.string().min(1),
      codeVerifier: z.string().min(1),
    })
    .strict(),
  z.object({ grantType: z.literal('origin') }).strict(),
])

const tokenResponseSchema = z
  .object({
    token: z.string(),
    expiresAt: z.string(),
    origin: z.string(),
  })
  .strict()
type TokenResponse = z.infer<typeof tokenResponseSchema>

export interface PairingRouterOptions {
  grants: PairingGrantStore
  codes: PairingCodeStore
  tokens: PairingTokenStore
}

export function createPairingRouter({ grants, codes, tokens }: PairingRouterOptions) {
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

  app.post('/api/pairing/token', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const parsed = tokenRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }

    if (parsed.data.grantType === 'code') {
      const redeemed = await codes.redeem(parsed.data.code, parsed.data.codeVerifier)
      if (redeemed === null) {
        return c.json({ error: 'invalid or expired code' }, 403)
      }
      const minted = tokens.mint(redeemed.origin)
      const response: TokenResponse = { ...minted, origin: redeemed.origin }
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
    const response: TokenResponse = { ...minted, origin }
    return c.json(response, 200)
  })

  return app
}
