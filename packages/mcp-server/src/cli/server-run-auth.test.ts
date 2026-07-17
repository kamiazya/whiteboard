// Integration tests for server-mode OAuth JWT auth wiring.
//
// Uses an in-memory EC key pair (no network) to test that
// createOAuthJwtValidator + createOAuthResourceServerAuthStrategy
// produce the correct AuthDecision for each JWT failure mode.

import { SignJWT, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { createOAuthJwtValidator } from '../server/security/oauth-jwt-validator.js'
import { createOAuthResourceServerAuthStrategy } from '../server/security/oauth-resource-strategy.js'
import type { AuthAuthorizeInput } from '../server/security/auth-strategy.js'

const ISSUER = 'https://auth.test.example'
const AUDIENCE = 'https://whiteboard.test.example'

async function makeValidator() {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const keyResolver = async () => publicKey
  const validator = createOAuthJwtValidator({
    issuer: ISSUER,
    audience: AUDIENCE,
    keyResolver,
    clockSkewSeconds: 60,
  })
  const strategy = createOAuthResourceServerAuthStrategy({ validator })
  return { privateKey, strategy }
}

async function signJwt(
  privateKey: CryptoKey,
  claims: Record<string, unknown> = {},
  overrides: { issuer?: string; audience?: string; expiresIn?: string } = {},
) {
  return new SignJWT({ sub: 'test-user', scope: 'canvas:read', ...claims })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '1h')
    .sign(privateKey)
}

function authInput(
  jwt: string | undefined,
  scopes: string[] = ['canvas:read'],
): AuthAuthorizeInput {
  return {
    method: 'GET',
    path: '/api/canvas/ws1/test',
    authorizationHeader: jwt ? `Bearer ${jwt}` : undefined,
    requiredScopes: scopes as never,
  }
}

describe('server-mode OAuth JWT auth wiring', () => {
  it('no auth header → 401', async () => {
    const { strategy } = await makeValidator()
    const decision = await strategy.authorize(authInput(undefined))
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.status).toBe(401)
    expect(decision.code).toBe('auth.required')
  })

  it('malformed token (not a JWT) → 401', async () => {
    const { strategy } = await makeValidator()
    const decision = await strategy.authorize(authInput('not-a-jwt'))
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.status).toBe(401)
  })

  it('valid JWT + matching scope → ok', async () => {
    const { privateKey, strategy } = await makeValidator()
    const jwt = await signJwt(privateKey, { scope: 'canvas:read' })
    const decision = await strategy.authorize(authInput(jwt, ['canvas:read']))
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.context.kind).toBe('oauth-resource-server')
  })

  it('wrong issuer → 401', async () => {
    const { privateKey, strategy } = await makeValidator()
    const jwt = await signJwt(privateKey, {}, { issuer: 'https://rogue.example' })
    const decision = await strategy.authorize(authInput(jwt))
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.status).toBe(401)
  })

  it('wrong audience → 401', async () => {
    const { privateKey, strategy } = await makeValidator()
    const jwt = await signJwt(privateKey, {}, { audience: 'https://wrong-aud.example' })
    const decision = await strategy.authorize(authInput(jwt))
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.status).toBe(401)
  })

  it('expired token → 401', async () => {
    const { privateKey, strategy } = await makeValidator()
    // Use expiresIn: '1s' but the exp claim is already in the past due to iat manipulation.
    // Instead, use jose's expiresIn relative to iat and set iat far in the past.
    const jwt = await new SignJWT({ sub: 'u', scope: 'canvas:read' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200) // iat 2h ago
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // exp 1h ago
      .sign(privateKey)
    const decision = await strategy.authorize(authInput(jwt))
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.status).toBe(401)
  })

  it('invalid signature → 401', async () => {
    const { strategy } = await makeValidator()
    // Sign with a completely different key pair — not trusted by this validator
    const { privateKey: untrustedKey } = await generateKeyPair('ES256')
    const jwt = await signJwt(untrustedKey)
    const decision = await strategy.authorize(authInput(jwt))
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.status).toBe(401)
  })

  it('insufficient scope → 403', async () => {
    const { privateKey, strategy } = await makeValidator()
    // Token has canvas:read but route requires canvas:write
    const jwt = await signJwt(privateKey, { scope: 'canvas:read' })
    const decision = await strategy.authorize(authInput(jwt, ['canvas:write']))
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.status).toBe(403)
    expect(decision.code).toBe('auth.forbidden')
  })

  it('keyResolver failure → 401 (validator_unavailable)', async () => {
    const validator = createOAuthJwtValidator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keyResolver: async () => {
        throw new Error('network error')
      },
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const { privateKey } = await generateKeyPair('ES256')
    const jwt = await signJwt(privateKey)
    const decision = await strategy.authorize(authInput(jwt))
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.status).toBe(401)
  })

  it('non-leak: auth decisions contain no raw JWT or URL values', async () => {
    const { privateKey, strategy } = await makeValidator()
    const jwt = await signJwt(privateKey, {}, { issuer: 'https://secret-auth.example' })
    const decision = await strategy.authorize(authInput(jwt))
    const asText = JSON.stringify(decision)
    expect(asText).not.toContain(jwt)
    expect(asText).not.toContain('secret-auth.example')
    expect(asText).not.toContain(ISSUER)
    expect(asText).not.toContain(AUDIENCE)
  })
})
