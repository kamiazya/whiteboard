// Integration tests for server-mode OAuth JWT auth wiring.
//
// Uses an in-memory EC key pair (no network) to test that
// createOAuthJwtValidator + createOAuthResourceServerAuthStrategy
// produce the correct AuthDecision for each JWT failure mode.

import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthAuthorizeInput } from '../server/security/auth-strategy.js'
import { createOAuthJwtValidator } from '../server/security/oauth-jwt-validator.js'
import type { AsyncAuthStrategy } from '../server/security/oauth-resource-strategy.js'
import { createOAuthResourceServerAuthStrategy } from '../server/security/oauth-resource-strategy.js'
import type { StartServerFn } from './server-run.js'
import { runServerRun } from './server-run.js'
import type { ServerRunArgs } from './server-run-args.js'

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

// Confirms that RunServerRunOptions.flags.jwtAllowUntypedAccessTokens (via env
// parsing) actually reaches createOAuthJwtValidator through runServerRun's
// wiring, not just that the two halves are separately unit-tested — a typo'd
// or dropped property name here would pass both of those suites unnoticed.
describe('runServerRun — jwtAllowUntypedAccessTokens wiring', () => {
  const JWKS_URI = 'https://auth.example.com/.well-known/jwks.json'

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      WHITEBOARD_SERVER_EXTERNAL_URL: 'https://whiteboard.example.com',
      WHITEBOARD_SERVER_AUTH_STRATEGY: 'oauth-jwt',
      WHITEBOARD_SERVER_JWT_ISSUER: ISSUER,
      WHITEBOARD_SERVER_JWT_AUDIENCE: AUDIENCE,
      WHITEBOARD_SERVER_JWKS_URI: JWKS_URI,
      ...overrides,
    }
  }

  function runArgs(): ServerRunArgs & { kind: 'ok' } {
    return {
      kind: 'ok',
      json: true,
      dryRun: false,
      trustedProxy: undefined,
      externalUrl: undefined,
      allowedOrigins: undefined,
      authStrategy: undefined,
      jwtIssuer: undefined,
      jwtAudience: undefined,
      jwksUri: undefined,
      jwtClockSkew: undefined,
      jwtScopeClaim: undefined,
      host: undefined,
      port: undefined,
      dataDir: undefined,
    }
  }

  async function bootAndCaptureAuthStrategy(env: NodeJS.ProcessEnv): Promise<AsyncAuthStrategy> {
    let capturedAuthStrategy: AsyncAuthStrategy | undefined
    const startServer: StartServerFn = async (opts) => {
      capturedAuthStrategy = opts.authStrategy
      return {
        port: opts.port,
        host: opts.host,
        startedAt: new Date().toISOString(),
        resolvedDataDir: '/tmp/mock-server-run-auth',
        instanceId: 'mock-instance-id',
        close: async () => {},
      }
    }
    const outcome = await runServerRun({ flags: runArgs(), env, startServer })
    expect(outcome.kind).toBe('running')
    if (!capturedAuthStrategy) throw new Error('authStrategy was not captured')
    return capturedAuthStrategy
  }

  async function stubJwksFetch(publicKey: CryptoKey) {
    const jwk = await exportJWK(publicKey)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [{ ...jwk, alg: 'ES256', use: 'sig' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
  }

  async function signUntypedAccessToken(privateKey: CryptoKey) {
    // No `typ` header and no `token_use` claim — this is the "untyped
    // access token" shape that createOAuthJwtValidator rejects by default
    // and accepts only when allowUntypedAccessTokens is true.
    return new SignJWT({ sub: 'test-user', scope: 'canvas:read' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)
  }

  it('WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS=true reaches the validator and accepts an untyped access token', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    await stubJwksFetch(publicKey)
    const authStrategy = await bootAndCaptureAuthStrategy(
      baseEnv({ WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS: 'true' }),
    )
    const jwt = await signUntypedAccessToken(privateKey)
    const decision = await authStrategy.authorize(authInput(jwt, ['canvas:read']))
    expect(decision.ok).toBe(true)
  })

  it('defaults to rejecting an untyped access token when the env var is unset', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    await stubJwksFetch(publicKey)
    const authStrategy = await bootAndCaptureAuthStrategy(baseEnv())
    const jwt = await signUntypedAccessToken(privateKey)
    const decision = await authStrategy.authorize(authInput(jwt, ['canvas:read']))
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.status).toBe(401)
  })
})
