import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import {
  computeS256Challenge,
  createPairingCodeStore,
  createPairingTokenStore,
} from '../security/pairing-session.js'
import { createPairingRouter } from './pairing.js'

const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'

let dir: string | null = null

function makeApp() {
  dir = mkdtempSync(join(tmpdir(), 'pairing-routes-'))
  const grants = createPairingGrantStore(dir)
  const codes = createPairingCodeStore()
  const tokens = createPairingTokenStore()
  return { app: createPairingRouter({ grants, codes, tokens }), grants, tokens }
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

async function post(
  app: ReturnType<typeof makeApp>['app'],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('pairing routes', () => {
  it('grant -> code -> token completes the full consent handshake', async () => {
    const { app, grants } = makeApp()
    const codeVerifier = 'the-hosted-app-verifier'
    const codeChallenge = await computeS256Challenge(codeVerifier)

    const grantRes = await post(app, '/api/pairing/grants', {
      origin: `${HOSTED}/deep/path`,
      codeChallenge,
    })
    expect(grantRes.status).toBe(201)
    const { origin, code } = (await grantRes.json()) as { origin: string; code: string }
    // Caller spelling is never trusted: normalized to the URL origin.
    expect(origin).toBe(HOSTED)
    expect(grants.origins()).toEqual([HOSTED])

    const tokenRes = await post(app, '/api/pairing/token', {
      grantType: 'code',
      code,
      codeVerifier,
    })
    expect(tokenRes.status).toBe(200)
    const token = (await tokenRes.json()) as { token: string; origin: string; expiresAt: string }
    expect(token.origin).toBe(HOSTED)
    expect(token.token.length).toBeGreaterThan(20)
  })

  it('a wrong PKCE verifier burns the code', async () => {
    const { app } = makeApp()
    const codeChallenge = await computeS256Challenge('right')
    const grantRes = await post(app, '/api/pairing/grants', { origin: HOSTED, codeChallenge })
    const { code } = (await grantRes.json()) as { code: string }

    expect(
      (await post(app, '/api/pairing/token', { grantType: 'code', code, codeVerifier: 'wrong' }))
        .status,
    ).toBe(403)
    expect(
      (await post(app, '/api/pairing/token', { grantType: 'code', code, codeVerifier: 'right' }))
        .status,
    ).toBe(403)
  })

  it('renewal mints a token for a granted Origin without a redirect', async () => {
    const { app, grants } = makeApp()
    grants.addGrant(HOSTED)

    const res = await post(app, '/api/pairing/token', { grantType: 'origin' }, { Origin: HOSTED })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { origin: string }).origin).toBe(HOSTED)
  })

  it('renewal rejects an ungranted origin and a missing Origin header', async () => {
    const { app } = makeApp()
    expect(
      (
        await post(
          app,
          '/api/pairing/token',
          { grantType: 'origin' },
          { Origin: 'https://evil.example.com' },
        )
      ).status,
    ).toBe(403)
    expect((await post(app, '/api/pairing/token', { grantType: 'origin' })).status).toBe(403)
  })

  it('lists grants and revokes one, killing its live session tokens', async () => {
    const { app, grants, tokens } = makeApp()
    const grant = grants.addGrant(HOSTED)
    const minted = tokens.mint(HOSTED)
    expect(tokens.validate(minted.token, HOSTED)).toBe(true)

    const listRes = await app.request('/api/pairing/grants')
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as { grants: { grantId: string; origin: string }[] }
    expect(listed.grants).toEqual([
      expect.objectContaining({ grantId: grant.grantId, origin: HOSTED }),
    ])

    const delRes = await app.request(`/api/pairing/grants/${grant.grantId}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    expect(grants.origins()).toEqual([])
    // Revocation must also kill the origin's live session tokens — a
    // revoked origin keeping a working 24h token would make revoke a lie.
    expect(tokens.validate(minted.token, HOSTED)).toBe(false)

    expect((await app.request('/api/pairing/grants/missing', { method: 'DELETE' })).status).toBe(
      404,
    )
  })

  it('rejects a javascript: grant origin', async () => {
    const { app } = makeApp()
    const res = await post(app, '/api/pairing/grants', {
      origin: 'javascript:alert(1)',
      codeChallenge: 'x',
    })
    expect(res.status).toBe(400)
  })
})
