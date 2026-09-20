import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listCredentialsResponseSchema,
  listGrantsResponseSchema,
  pairingTokenResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import { afterEach, describe, expect, it } from 'vitest'
import { registrationFor as registration } from '../../shared/test-utils/webauthn-fixtures.js'
import { buildSignedPayload, createDaemonIdentity } from '../security/daemon-identity.js'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import {
  computeS256Challenge,
  createPairingCodeStore,
  createPairingTokenStore,
} from '../security/pairing-session.js'
import { createWebAuthnCredentialStore } from '../security/webauthn-credential-store.js'
import { createPairingRouter } from './pairing.js'

const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'

let dir: string | null = null

function makeApp() {
  dir = mkdtempSync(join(tmpdir(), 'pairing-routes-'))
  const grants = createPairingGrantStore(dir)
  const codes = createPairingCodeStore()
  const tokens = createPairingTokenStore()
  const identity = createDaemonIdentity({ dataDir: dir })
  const credentials = createWebAuthnCredentialStore(dir)
  return {
    app: createPairingRouter({ grants, codes, tokens, credentials, identity }),
    grants,
    tokens,
    credentials,
    identity,
  }
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
    // Executable mutation-check guard: parses the REAL HTTP body against the
    // shared schema, so a server-side field drift (or a removed route-level
    // .parse) turns this red instead of shipping silently.
    const token = pairingTokenResponseSchema.parse(await tokenRes.json())
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
    // Same executable guard as the code-exchange leg above, for the
    // renewal leg's response body.
    expect(pairingTokenResponseSchema.parse(await res.json()).origin).toBe(HOSTED)
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
    // Executable mutation-check guard: parses the REAL HTTP body against the
    // shared schema, so a server-side field drift turns this red instead of
    // shipping silently to the client's separate copy (there is no longer
    // one — PairedOriginsCard imports this same schema).
    const listed = listGrantsResponseSchema.parse(await listRes.json())
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

describe('pairing token identity signatures', () => {
  const NONCE = Buffer.from('fedcba9876543210').toString('base64url')

  function verifies(
    identity: { publicKey: string },
    parts: readonly string[],
    signatureB64u: string,
  ) {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKey },
      format: 'jwk',
    })
    return cryptoVerify(
      null,
      buildSignedPayload(parts),
      key,
      Buffer.from(signatureB64u, 'base64url'),
    )
  }

  it('a renewal carrying a nonce gets a signature vouching for the minted token', async () => {
    const { app, grants, identity } = makeApp()
    grants.addGrant(HOSTED)

    const res = await post(
      app,
      '/api/pairing/token',
      { grantType: 'origin', nonce: NONCE },
      { Origin: HOSTED },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      expiresAt: string
      origin: string
      identity?: { alg: string; publicKey: string; signature: string }
    }
    expect(body.identity?.publicKey).toBe(identity.publicKey)
    const tokenHash = createHash('sha256').update(body.token, 'utf8').digest('base64url')
    expect(
      verifies(
        identity,
        ['wb-token-v1', NONCE, body.origin, tokenHash, body.expiresAt],
        body.identity?.signature ?? '',
      ),
    ).toBe(true)
    // The signature must NOT verify for a different token (splice attempt).
    const otherHash = createHash('sha256').update('forged-token', 'utf8').digest('base64url')
    expect(
      verifies(
        identity,
        ['wb-token-v1', NONCE, body.origin, otherHash, body.expiresAt],
        body.identity?.signature ?? '',
      ),
    ).toBe(false)
  })

  it('rejects malformed and out-of-range nonces with 400', async () => {
    const { app, grants } = makeApp()
    grants.addGrant(HOSTED)
    const bad = [
      '!!!not-base64url!!!',
      Buffer.alloc(15).toString('base64url'), // one byte short
      Buffer.alloc(33).toString('base64url'), // one byte long
    ]
    for (const nonce of bad) {
      const res = await post(
        app,
        '/api/pairing/token',
        { grantType: 'origin', nonce },
        { Origin: HOSTED },
      )
      expect(res.status).toBe(400)
    }
  })

  it('a request without a nonce gets no identity field (wire-compat)', async () => {
    const { app, grants } = makeApp()
    grants.addGrant(HOSTED)
    const res = await post(app, '/api/pairing/token', { grantType: 'origin' }, { Origin: HOSTED })
    const body = (await res.json()) as { identity?: unknown }
    expect(res.status).toBe(200)
    expect(body.identity).toBeUndefined()
  })

  it('the code-exchange leg also signs when a nonce is present', async () => {
    const { app, identity } = makeApp()
    const codeVerifier = 'exchange-verifier'
    const codeChallenge = await computeS256Challenge(codeVerifier)
    const grantRes = await post(app, '/api/pairing/grants', { origin: HOSTED, codeChallenge })
    const { code } = (await grantRes.json()) as { code: string }

    const res = await post(app, '/api/pairing/token', {
      grantType: 'code',
      code,
      codeVerifier,
      nonce: NONCE,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      expiresAt: string
      origin: string
      identity?: { signature: string }
    }
    const tokenHash = createHash('sha256').update(body.token, 'utf8').digest('base64url')
    expect(
      verifies(
        identity,
        ['wb-token-v1', NONCE, body.origin, tokenHash, body.expiresAt],
        body.identity?.signature ?? '',
      ),
    ).toBe(true)
  })

  describe('credential pins', () => {
    const HOST = new URL(HOSTED).hostname

    it('a granted origin pins a passkey, lists it without the key, and revokes it', async () => {
      const { app, grants, credentials } = makeApp()
      grants.addGrant(HOSTED)
      const { keypair: _keypair, ...body } = registration(HOST)

      const res = await post(app, '/api/pairing/credentials', body, { Origin: HOSTED })
      expect(res.status).toBe(201)
      const pinned = (await res.json()) as { credentialId: string; origin: string }
      expect(pinned).toMatchObject({
        credentialId: body.credentialId,
        origin: HOSTED,
        backupEligible: true,
      })
      // The pin holds the P-256 key the registration carried, keyed by origin.
      expect(credentials.find(HOSTED, body.credentialId)?.publicKeyJwk.crv).toBe('P-256')
      expect(credentials.find(HOSTED, body.credentialId)?.rpId).toBe(HOST)

      const list = await app.request('/api/pairing/credentials')
      const listed = listCredentialsResponseSchema.parse(await list.json())
      expect(listed.credentials.map((c) => c.credentialId)).toEqual([body.credentialId])
      expect(JSON.stringify(listed)).not.toContain('publicKey')

      const del = await app.request(`/api/pairing/credentials/${body.credentialId}`, {
        method: 'DELETE',
      })
      expect(del.status).toBe(200)
      expect(credentials.list()).toEqual([])
      expect(
        (await app.request(`/api/pairing/credentials/${body.credentialId}`, { method: 'DELETE' }))
          .status,
      ).toBe(404)
    })

    it('refuses a pin from an origin without a grant, without an Origin header, or for another relying party', async () => {
      const { app, grants, credentials } = makeApp()
      const { keypair: _keypair, ...body } = registration(HOST)
      expect((await post(app, '/api/pairing/credentials', body, { Origin: HOSTED })).status).toBe(
        403,
      )
      expect((await post(app, '/api/pairing/credentials', body)).status).toBe(403)

      grants.addGrant(HOSTED)
      // Registered for a different rpId than the granted origin's host.
      const { keypair: _foreignKeypair, ...foreignBody } = registration('evil.example')
      const foreign = await post(app, '/api/pairing/credentials', foreignBody, {
        Origin: HOSTED,
      })
      expect(foreign.status).toBe(400)
      expect(await foreign.json()).toEqual({
        error: 'registration_rejected',
        message: 'rpIdHash',
      })
      // A gesture without user verification is not one a promote can rely on.
      const { keypair: _noUvKeypair, ...noUvBody } = registration(HOST, { uv: false })
      const noUv = await post(app, '/api/pairing/credentials', noUvBody, {
        Origin: HOSTED,
      })
      expect(noUv.status).toBe(400)
      expect(await noUv.json()).toEqual({
        error: 'registration_rejected',
        message: 'userVerification',
      })
      expect(credentials.list()).toEqual([])
    })
  })
})
