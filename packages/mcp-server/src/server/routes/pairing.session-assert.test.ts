/**
 * POST /api/pairing/session-assert/challenge and POST /api/pairing/session-assert
 * (ADR-0041 S0-2): a paired browser session becomes a PERSON's session by
 * asserting a pinned passkey over a daemon-minted, session-scoped challenge.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type SessionAssertChallengeResponse,
  type SessionAssertResponse,
  sessionAssertChallengeResponseSchema,
  sessionAssertResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAssertion,
  registrationFor,
  WEBAUTHN_FLAG_BE,
  WEBAUTHN_FLAG_UP,
  WEBAUTHN_FLAG_UV,
} from '../../shared/test-utils/webauthn-fixtures.js'
import { createDaemonIdentity } from '../security/daemon-identity.js'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import { createPairingCodeStore, createPairingTokenStore } from '../security/pairing-session.js'
import { createWebAuthnCredentialStore } from '../security/webauthn-credential-store.js'
import { createPairingRouter } from './pairing.js'

const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'
const HOST = new URL(HOSTED).hostname
const FLAGS = WEBAUTHN_FLAG_UP | WEBAUTHN_FLAG_UV | WEBAUTHN_FLAG_BE

let dir: string | null = null

function makeApp() {
  dir = mkdtempSync(join(tmpdir(), 'pairing-session-assert-'))
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

/** Grants an origin, pins a passkey (keeping the private key), and mints a
 *  pairing session token for it. */
async function pairedSession(fixture: ReturnType<typeof makeApp>, origin = HOSTED) {
  fixture.grants.addGrant(origin)
  const reg = registrationFor(new URL(origin).hostname)
  const { keypair, ...registration } = reg
  const pinRes = await post(fixture.app, '/api/pairing/credentials', registration, {
    Origin: origin,
  })
  expect(pinRes.status).toBe(201)
  const tokenRes = await post(
    fixture.app,
    '/api/pairing/token',
    { grantType: 'origin' },
    { Origin: origin },
  )
  expect(tokenRes.status).toBe(200)
  const { token } = (await tokenRes.json()) as { token: string }
  return { token, credentialId: registration.credentialId, keypair, origin }
}

async function mintChallenge(fixture: ReturnType<typeof makeApp>, token: string, origin: string) {
  const res = await fixture.app.request('/api/pairing/session-assert/challenge', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: origin },
  })
  return res
}

describe('POST /api/pairing/session-assert/challenge', () => {
  it('refuses with no bearer', async () => {
    const fixture = makeApp()
    const res = await fixture.app.request('/api/pairing/session-assert/challenge', {
      method: 'POST',
      headers: { Origin: HOSTED },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('refuses a token presented with the wrong origin', async () => {
    const fixture = makeApp()
    const { token } = await pairedSession(fixture)
    const res = await mintChallenge(fixture, token, 'https://evil.example.com')
    expect(res.status).toBe(401)
  })

  it('mints a schema-valid 43-char challenge for a valid session', async () => {
    const fixture = makeApp()
    const { token } = await pairedSession(fixture)
    const res = await mintChallenge(fixture, token, HOSTED)
    expect(res.status).toBe(200)
    const body: SessionAssertChallengeResponse = sessionAssertChallengeResponseSchema.parse(
      await res.json(),
    )
    expect(body.challenge).toHaveLength(43)
  })
})

describe('the challenge is scoped to the SESSION TOKEN, not the origin', () => {
  it('a challenge minted for one session cannot be spent by a different session bound to the same origin', async () => {
    const fixture = makeApp()
    const { credentialId, keypair } = await pairedSession(fixture)
    // Two independent tokens, both valid for the same origin — the shape
    // that makes a mistaken origin-keyed challenge store bite.
    const tokenA = fixture.tokens.mint(HOSTED).token
    const tokenB = fixture.tokens.mint(HOSTED).token

    const challengeRes = await mintChallenge(fixture, tokenA, HOSTED)
    const { challenge } = sessionAssertChallengeResponseSchema.parse(await challengeRes.json())
    const assertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: HOST,
      origin: HOSTED,
      challenge: Buffer.from(challenge, 'base64url'),
      flags: FLAGS,
      signCount: 1,
    })

    const res = await post(
      fixture.app,
      '/api/pairing/session-assert',
      {
        credentialId,
        authenticatorData: assertion.authenticatorData.toString('base64url'),
        clientDataJSON: assertion.clientDataJSON.toString('base64url'),
        signature: assertion.signature.toString('base64url'),
      },
      // Presented under TOKEN B, which never minted this challenge.
      { Authorization: `Bearer ${tokenB}`, Origin: HOSTED },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'assertion_rejected', message: 'challenge' })
  })
})

describe('POST /api/pairing/session-assert', () => {
  it('completes the full pin -> challenge -> assertion path and binds the session', async () => {
    const fixture = makeApp()
    const { token, credentialId, keypair } = await pairedSession(fixture)

    const challengeRes = await mintChallenge(fixture, token, HOSTED)
    const { challenge } = sessionAssertChallengeResponseSchema.parse(await challengeRes.json())
    const nonce = Buffer.from(challenge, 'base64url')

    const assertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: HOST,
      origin: HOSTED,
      challenge: nonce,
      flags: FLAGS,
      signCount: 1,
    })

    const res = await post(
      fixture.app,
      '/api/pairing/session-assert',
      {
        credentialId,
        authenticatorData: assertion.authenticatorData.toString('base64url'),
        clientDataJSON: assertion.clientDataJSON.toString('base64url'),
        signature: assertion.signature.toString('base64url'),
      },
      { Authorization: `Bearer ${token}`, Origin: HOSTED },
    )
    expect(res.status).toBe(200)
    const body: SessionAssertResponse = sessionAssertResponseSchema.parse(await res.json())
    expect(body).toEqual({ credentialId, profileId: null, boundUntil: expect.any(String) })

    expect(fixture.tokens.bindingOf(token, HOSTED)).toEqual({ origin: HOSTED, credentialId })
  })

  it('refuses an assertion over a fabricated challenge', async () => {
    const fixture = makeApp()
    const { token, credentialId, keypair } = await pairedSession(fixture)
    await mintChallenge(fixture, token, HOSTED)

    const fabricated = Buffer.alloc(32, 7)
    const assertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: HOST,
      origin: HOSTED,
      challenge: fabricated,
      flags: FLAGS,
      signCount: 1,
    })
    const res = await post(
      fixture.app,
      '/api/pairing/session-assert',
      {
        credentialId,
        authenticatorData: assertion.authenticatorData.toString('base64url'),
        clientDataJSON: assertion.clientDataJSON.toString('base64url'),
        signature: assertion.signature.toString('base64url'),
      },
      { Authorization: `Bearer ${token}`, Origin: HOSTED },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'assertion_rejected', message: 'challenge' })
  })

  it('refuses a replayed assertion (the challenge is single-use)', async () => {
    const fixture = makeApp()
    const { token, credentialId, keypair } = await pairedSession(fixture)
    const challengeRes = await mintChallenge(fixture, token, HOSTED)
    const { challenge } = sessionAssertChallengeResponseSchema.parse(await challengeRes.json())
    const nonce = Buffer.from(challenge, 'base64url')
    const assertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: HOST,
      origin: HOSTED,
      challenge: nonce,
      flags: FLAGS,
      signCount: 1,
    })
    const body = {
      credentialId,
      authenticatorData: assertion.authenticatorData.toString('base64url'),
      clientDataJSON: assertion.clientDataJSON.toString('base64url'),
      signature: assertion.signature.toString('base64url'),
    }
    const first = await post(fixture.app, '/api/pairing/session-assert', body, {
      Authorization: `Bearer ${token}`,
      Origin: HOSTED,
    })
    expect(first.status).toBe(200)

    const second = await post(fixture.app, '/api/pairing/session-assert', body, {
      Authorization: `Bearer ${token}`,
      Origin: HOSTED,
    })
    expect(second.status).toBe(403)
    expect(await second.json()).toEqual({ error: 'assertion_rejected', message: 'challenge' })
  })

  it('refuses an expired challenge', async () => {
    const fixture = makeApp()
    const { token, credentialId, keypair } = await pairedSession(fixture)
    const challengeRes = await mintChallenge(fixture, token, HOSTED)
    const { challenge } = sessionAssertChallengeResponseSchema.parse(await challengeRes.json())
    const nonce = Buffer.from(challenge, 'base64url')
    const assertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: HOST,
      origin: HOSTED,
      challenge: nonce,
      flags: FLAGS,
      signCount: 1,
    })

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 60_001)
      const res = await post(
        fixture.app,
        '/api/pairing/session-assert',
        {
          credentialId,
          authenticatorData: assertion.authenticatorData.toString('base64url'),
          clientDataJSON: assertion.clientDataJSON.toString('base64url'),
          signature: assertion.signature.toString('base64url'),
        },
        { Authorization: `Bearer ${token}`, Origin: HOSTED },
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'assertion_rejected', message: 'challenge' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a credential pinned by a different origin: unknown_credential', async () => {
    const fixture = makeApp()
    const { token, keypair } = await pairedSession(fixture, HOSTED)
    // A second origin/grant with its OWN pin.
    const otherOrigin = 'https://other.kamiazya-whiteboard.pages.dev'
    await pairedSession(fixture, otherOrigin)

    const challengeRes = await mintChallenge(fixture, token, HOSTED)
    const { challenge } = sessionAssertChallengeResponseSchema.parse(await challengeRes.json())
    const nonce = Buffer.from(challenge, 'base64url')
    const assertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: new URL(otherOrigin).hostname,
      origin: HOSTED,
      challenge: nonce,
      flags: FLAGS,
      signCount: 1,
    })
    // Claim the OTHER origin's credential id while presenting HOSTED's token.
    const otherCredentialId = registrationFor(new URL(otherOrigin).hostname).credentialId
    const res = await post(
      fixture.app,
      '/api/pairing/session-assert',
      {
        credentialId: otherCredentialId,
        authenticatorData: assertion.authenticatorData.toString('base64url'),
        clientDataJSON: assertion.clientDataJSON.toString('base64url'),
        signature: assertion.signature.toString('base64url'),
      },
      { Authorization: `Bearer ${token}`, Origin: HOSTED },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: 'unknown_credential',
      message: expect.any(String),
    })
  })

  it('refuses a tampered signature', async () => {
    const fixture = makeApp()
    const { token, credentialId, keypair } = await pairedSession(fixture)
    const challengeRes = await mintChallenge(fixture, token, HOSTED)
    const { challenge } = sessionAssertChallengeResponseSchema.parse(await challengeRes.json())
    const nonce = Buffer.from(challenge, 'base64url')
    const assertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: HOST,
      origin: HOSTED,
      challenge: nonce,
      flags: FLAGS,
      signCount: 1,
    })
    const tampered = Buffer.from(assertion.signature)
    tampered[tampered.length - 1] ^= 0xff
    const res = await post(
      fixture.app,
      '/api/pairing/session-assert',
      {
        credentialId,
        authenticatorData: assertion.authenticatorData.toString('base64url'),
        clientDataJSON: assertion.clientDataJSON.toString('base64url'),
        signature: tampered.toString('base64url'),
      },
      { Authorization: `Bearer ${token}`, Origin: HOSTED },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'assertion_rejected', message: 'signature' })
  })

  it('refuses a sign count that did not advance', async () => {
    const fixture = makeApp()
    const { token, credentialId, keypair } = await pairedSession(fixture)

    // First assertion at signCount 1 succeeds and records it.
    const first = sessionAssertChallengeResponseSchema.parse(
      await (await mintChallenge(fixture, token, HOSTED)).json(),
    )
    const firstAssertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: HOST,
      origin: HOSTED,
      challenge: Buffer.from(first.challenge, 'base64url'),
      flags: FLAGS,
      signCount: 1,
    })
    const firstRes = await post(
      fixture.app,
      '/api/pairing/session-assert',
      {
        credentialId,
        authenticatorData: firstAssertion.authenticatorData.toString('base64url'),
        clientDataJSON: firstAssertion.clientDataJSON.toString('base64url'),
        signature: firstAssertion.signature.toString('base64url'),
      },
      { Authorization: `Bearer ${token}`, Origin: HOSTED },
    )
    expect(firstRes.status).toBe(200)

    // A second assertion, fresh challenge, but signCount did not advance.
    const second = sessionAssertChallengeResponseSchema.parse(
      await (await mintChallenge(fixture, token, HOSTED)).json(),
    )
    const secondAssertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: HOST,
      origin: HOSTED,
      challenge: Buffer.from(second.challenge, 'base64url'),
      flags: FLAGS,
      signCount: 1,
    })
    const secondRes = await post(
      fixture.app,
      '/api/pairing/session-assert',
      {
        credentialId,
        authenticatorData: secondAssertion.authenticatorData.toString('base64url'),
        clientDataJSON: secondAssertion.clientDataJSON.toString('base64url'),
        signature: secondAssertion.signature.toString('base64url'),
      },
      { Authorization: `Bearer ${token}`, Origin: HOSTED },
    )
    expect(secondRes.status).toBe(403)
    expect(await secondRes.json()).toEqual({ error: 'assertion_rejected', message: 'signCount' })
  })

  it('after revokeBoundTo, the bound token is refused on both routes', async () => {
    const fixture = makeApp()
    const { token, credentialId, keypair } = await pairedSession(fixture)
    const { challenge } = sessionAssertChallengeResponseSchema.parse(
      await (await mintChallenge(fixture, token, HOSTED)).json(),
    )
    const assertion = buildAssertion({
      privateKey: keypair.privateKey,
      rpId: HOST,
      origin: HOSTED,
      challenge: Buffer.from(challenge, 'base64url'),
      flags: FLAGS,
      signCount: 1,
    })
    const bindRes = await post(
      fixture.app,
      '/api/pairing/session-assert',
      {
        credentialId,
        authenticatorData: assertion.authenticatorData.toString('base64url'),
        clientDataJSON: assertion.clientDataJSON.toString('base64url'),
        signature: assertion.signature.toString('base64url'),
      },
      { Authorization: `Bearer ${token}`, Origin: HOSTED },
    )
    expect(bindRes.status).toBe(200)

    expect(fixture.tokens.revokeBoundTo([{ origin: HOSTED, credentialId }])).toBe(1)

    expect((await mintChallenge(fixture, token, HOSTED)).status).toBe(401)
    const assertAfter = await post(
      fixture.app,
      '/api/pairing/session-assert',
      {
        credentialId,
        authenticatorData: assertion.authenticatorData.toString('base64url'),
        clientDataJSON: assertion.clientDataJSON.toString('base64url'),
        signature: assertion.signature.toString('base64url'),
      },
      { Authorization: `Bearer ${token}`, Origin: HOSTED },
    )
    expect(assertAfter.status).toBe(401)
  })
})
