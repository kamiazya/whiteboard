import { Hono } from 'hono'
import {
  SignJWT,
  UnsecuredJWT,
  generateKeyPair,
  type CryptoKey,
  type JWTHeaderParameters,
} from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { createAsyncAuthStrategyMiddleware } from './oauth-resource-strategy.js'
import { createOAuthResourceServerAuthStrategy } from './oauth-resource-strategy.js'
import { type JwtKeyResolver, createOAuthJwtValidator } from './oauth-jwt-validator.js'

const TEST_ISSUER = 'https://idp.example.com/'
const TEST_AUDIENCE = 'https://resource.example.com'
const TEST_KID = 'key-1'

let privateKey: CryptoKey
let publicKey: CryptoKey

beforeAll(async () => {
  const kp = await generateKeyPair('ES256')
  privateKey = kp.privateKey
  publicKey = kp.publicKey
})

interface TokenOptions {
  alg?: string
  kid?: string
  key?: CryptoKey | Uint8Array
  sub?: string | null
  iss?: string
  aud?: string | string[]
  scope?: string
  scp?: string[] | string
  expOffset?: number // seconds from now, default +3600
  nbf?: number // absolute epoch
  omitExp?: boolean
  extra?: Record<string, unknown>
}

async function buildToken({
  alg = 'ES256',
  kid = TEST_KID,
  key,
  sub = 'user-42',
  iss = TEST_ISSUER,
  aud = TEST_AUDIENCE,
  scope,
  scp,
  expOffset = 3600,
  nbf,
  omitExp = false,
  extra = {},
}: TokenOptions = {}): Promise<string> {
  const signingKey = key ?? privateKey
  const payload: Record<string, unknown> = { ...extra }
  if (scope !== undefined) payload.scope = scope
  if (scp !== undefined) payload.scp = scp
  if (nbf !== undefined) payload.nbf = nbf

  const builder = new SignJWT(payload).setProtectedHeader({ alg, kid })
  if (sub !== null) builder.setSubject(sub)
  if (iss) builder.setIssuer(iss)
  if (aud) builder.setAudience(aud)
  if (!omitExp) builder.setExpirationTime(`${expOffset}s`)

  return builder.sign(signingKey)
}

function makeDefaultResolver(): JwtKeyResolver {
  return async () => publicKey
}

function makeTrackingResolver(): {
  resolver: JwtKeyResolver
  calls: JWTHeaderParameters[]
} {
  const calls: JWTHeaderParameters[] = []
  return {
    resolver: async (header) => {
      calls.push({ ...header })
      return publicKey
    },
    calls,
  }
}

function makeValidator(overrides: Partial<Parameters<typeof createOAuthJwtValidator>[0]> = {}) {
  return createOAuthJwtValidator({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    keyResolver: makeDefaultResolver(),
    ...overrides,
  })
}

// ── Valid token success path ─────────────────────────────────────────────────

describe('createOAuthJwtValidator — valid token', () => {
  it('returns ok with subject / issuer / audience / scopes / expiresAt for a signed ES256 JWT', async () => {
    const token = await buildToken({ scope: 'canvas:read canvas:write' })
    const validator = makeValidator()
    const result = await validator.validate({ token, requiredScopes: ['canvas:read'] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.subject).toBe('user-42')
    expect(result.issuer).toBe(TEST_ISSUER)
    expect(result.audience).toEqual(TEST_AUDIENCE)
    expect(result.scopes).toContain('canvas:read')
    expect(result.scopes).toContain('canvas:write')
    expect(typeof result.expiresAt).toBe('number')
  })

  it('exp claim absent → malformed (exp is required for access tokens)', async () => {
    const token = await buildToken({ omitExp: true, scope: 'canvas:read' })
    const result = await makeValidator().validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })

  it('empty requiredScopes always passes', async () => {
    const token = await buildToken({ scope: '' })
    const result = await makeValidator().validate({ token, requiredScopes: [] })
    expect(result.ok).toBe(true)
  })
})

// ── Scope handling ───────────────────────────────────────────────────────────

describe('createOAuthJwtValidator — scope handling', () => {
  it('parses space-delimited scope claim into AuthScope[]', async () => {
    const token = await buildToken({ scope: 'canvas:read workspace:read versions:read' })
    const result = await makeValidator().validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.scopes).toEqual(
        expect.arrayContaining(['canvas:read', 'workspace:read', 'versions:read']),
      )
      expect(result.scopes).toHaveLength(3)
    }
  })

  it('parses scp array claim when scopeClaim is scp', async () => {
    const token = await buildToken({ scp: ['canvas:read', 'canvas:write'] })
    const validator = makeValidator({ scopeClaim: 'scp' })
    const result = await validator.validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scopes).toEqual(expect.arrayContaining(['canvas:read', 'canvas:write']))
  })

  it('parses scp space-delimited string when scopeClaim is scp', async () => {
    const token = await buildToken({ scp: 'canvas:read workspace:write' })
    const validator = makeValidator({ scopeClaim: 'scp' })
    const result = await validator.validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scopes).toEqual(expect.arrayContaining(['canvas:read', 'workspace:write']))
  })

  it('unknown scope strings are silently discarded — not present in result.scopes', async () => {
    const token = await buildToken({ scope: 'canvas:read openid profile email admin' })
    const result = await makeValidator().validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scopes).not.toContain('openid')
    expect(result.scopes).not.toContain('profile')
    expect(result.scopes).not.toContain('email')
    expect(result.scopes).not.toContain('admin')
    expect(result.scopes).toContain('canvas:read')
  })

  it('unknown scopes do not satisfy required AuthScope → insufficient_scope', async () => {
    // Token has only unknown scopes; requiredScopes has canvas:write
    const token = await buildToken({ scope: 'openid profile' })
    const result = await makeValidator().validate({ token, requiredScopes: ['canvas:write'] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('insufficient_scope')
  })

  it('missing required scope → insufficient_scope', async () => {
    const token = await buildToken({ scope: 'canvas:read' })
    const result = await makeValidator().validate({ token, requiredScopes: ['canvas:write'] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('insufficient_scope')
  })

  it('all required scopes present → ok', async () => {
    const token = await buildToken({ scope: 'canvas:read canvas:write workspace:read' })
    const result = await makeValidator().validate({
      token,
      requiredScopes: ['canvas:read', 'canvas:write'],
    })
    expect(result.ok).toBe(true)
  })
})

// ── Claim validation ─────────────────────────────────────────────────────────

describe('createOAuthJwtValidator — claim validation', () => {
  it('issuer mismatch → invalid_issuer', async () => {
    const token = await buildToken({ iss: 'https://wrong-idp.example.com/' })
    const result = await makeValidator().validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_issuer')
  })

  it('audience mismatch → invalid_audience', async () => {
    const token = await buildToken({ aud: 'https://other-service.example.com' })
    const result = await makeValidator().validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_audience')
  })

  it('expired token → expired', async () => {
    const token = await buildToken({ expOffset: -60 }) // expired 60s ago
    const result = await makeValidator({ clockSkewSeconds: 0 }).validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('expired')
  })

  it('nbf in future → malformed', async () => {
    const nbf = Math.floor(Date.now() / 1000) + 7200 // valid in 2h
    const token = await buildToken({ nbf })
    const result = await makeValidator({ clockSkewSeconds: 0 }).validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })

  it('missing sub → malformed', async () => {
    const token = await buildToken({ sub: null })
    const result = await makeValidator().validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })

  it('non-JWT string → malformed', async () => {
    const result = await makeValidator().validate({ token: 'not-a-jwt', requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })

  it('truncated JWT → malformed', async () => {
    const token = await buildToken()
    const truncated = token.slice(0, token.length / 2)
    const result = await makeValidator().validate({ token: truncated, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })
})

// ── Algorithm policy ─────────────────────────────────────────────────────────

describe('createOAuthJwtValidator — algorithm policy', () => {
  it('ES256 with allowedAlgorithms [ES256] → ok', async () => {
    const token = await buildToken({ alg: 'ES256' })
    const result = await makeValidator({ allowedAlgorithms: ['ES256'] }).validate({
      token,
      requiredScopes: [],
    })
    expect(result.ok).toBe(true)
  })

  it('HS256 when allowedAlgorithms is [RS256, ES256] → invalid_signature', async () => {
    const hmacKey = new TextEncoder().encode('secret-key-at-least-256-bits-xxxxx')
    const token = await buildToken({ alg: 'HS256', key: hmacKey })
    const result = await makeValidator({ allowedAlgorithms: ['RS256', 'ES256'] }).validate({
      token,
      requiredScopes: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_signature')
  })

  it('alg:none (UnsecuredJWT) → invalid_signature', async () => {
    const unsecured = new UnsecuredJWT({ sub: 'user-42', scope: 'canvas:read' })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime('1h')
      .encode()
    const result = await makeValidator().validate({ token: unsecured, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_signature')
  })

  it('tampered signature → invalid_signature', async () => {
    const token = await buildToken({ scope: 'canvas:read' })
    const parts = token.split('.')
    parts[2] = parts[2].slice(0, -4) + 'XXXX'
    const tampered = parts.join('.')
    const result = await makeValidator().validate({ token: tampered, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_signature')
  })
})

// ── Key resolver seam ────────────────────────────────────────────────────────

describe('createOAuthJwtValidator — key resolver', () => {
  it('keyResolver receives protectedHeader with kid and alg', async () => {
    const { resolver, calls } = makeTrackingResolver()
    const token = await buildToken({ alg: 'ES256', kid: 'my-key-id' })
    const validator = createOAuthJwtValidator({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      keyResolver: resolver,
    })

    await validator.validate({ token, requiredScopes: [] })

    expect(calls).toHaveLength(1)
    expect(calls[0].alg).toBe('ES256')
    expect(calls[0].kid).toBe('my-key-id')
  })

  it('keyResolver does NOT receive the raw JWT token string', async () => {
    const CANARY = 'canary-token-xyz-12345'
    const captured: unknown[] = []
    const resolver: JwtKeyResolver = async (header) => {
      // Capture everything passed to resolver
      captured.push(header)
      return publicKey
    }
    const token = await buildToken({ extra: { canary: CANARY } })
    const validator = createOAuthJwtValidator({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      keyResolver: resolver,
    })

    await validator.validate({ token, requiredScopes: [] })

    const serialized = JSON.stringify(captured)
    expect(serialized).not.toContain(CANARY)
    // The token itself must not be in the resolver call
    expect(serialized).not.toContain(token)
  })

  it('keyResolver throws → validator_unavailable', async () => {
    const throwingResolver: JwtKeyResolver = async () => {
      throw new Error('ECONNREFUSED https://idp.example.com/.well-known/jwks.json')
    }
    const token = await buildToken()
    const validator = createOAuthJwtValidator({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      keyResolver: throwingResolver,
    })

    const result = await validator.validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('validator_unavailable')
  })

  it('keyResolver throw does not leak error message or IdP URL into result', async () => {
    const IDP_URL = 'https://secret-idp.corp.internal/.well-known/jwks.json'
    const throwingResolver: JwtKeyResolver = async () => {
      throw new Error(`Network error: ECONNREFUSED ${IDP_URL}`)
    }
    const token = await buildToken({ scope: 'canvas:read' })
    const validator = createOAuthJwtValidator({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      keyResolver: throwingResolver,
    })

    const result = await validator.validate({ token, requiredScopes: [] })

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('ECONNREFUSED')
    expect(serialized).not.toContain(IDP_URL)
    expect(serialized).not.toContain('Network error')
  })
})

// ── Non-leak sweep ───────────────────────────────────────────────────────────

describe('createOAuthJwtValidator — non-leak sweep', () => {
  it('issuer mismatch failure does not echo issuer URL', async () => {
    const WRONG_ISSUER = 'https://wrong-issuer.example.com/'
    const token = await buildToken({ iss: WRONG_ISSUER })
    const result = await makeValidator().validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(WRONG_ISSUER)
    expect(serialized).not.toContain('wrong-issuer.example.com')
  })

  it('audience mismatch failure does not echo audience value', async () => {
    const WRONG_AUD = 'https://wrong-audience.example.com'
    const token = await buildToken({ aud: WRONG_AUD })
    const result = await makeValidator().validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(WRONG_AUD)
    expect(serialized).not.toContain('wrong-audience.example.com')
  })

  it('failure result never contains the raw JWT token string', async () => {
    const CANARY = 'canary-jwt-content-XYZ'
    const token = await buildToken({ iss: 'https://wrong.example.com/', extra: { canary: CANARY } })
    const result = await makeValidator().validate({ token, requiredScopes: [] })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(CANARY)
    // eyJ is the base64url prefix of any JWT header
    expect(serialized).not.toContain('eyJ')
  })
})

// ── PBT: unknown scopes do not satisfy AuthScope requirements ─────────────────

fcTest.prop(
  [
    fc.array(
      fc.string({ minLength: 1, maxLength: 20 }).filter(
        (s) =>
          !s.includes(' ') &&
          !['canvas:read', 'canvas:write', 'workspace:read', 'workspace:write',
            'versions:read', 'versions:write', 'files:read', 'files:write',
            'runtime:read', 'runtime:admin', 'mcp:call'].includes(s),
      ),
      { minLength: 1, maxLength: 5 },
    ),
  ],
  withDefaults(),
)(
  'any set of unknown scope strings in the token never satisfies a canvas:read requirement',
  async (unknownScopes) => {
    const scope = unknownScopes.join(' ')
    const token = await buildToken({ scope })
    const result = await makeValidator().validate({ token, requiredScopes: ['canvas:read'] })

    // Unknown scopes must not authorize the request.
    // The failure decision is { ok: false, reason: 'insufficient_scope' } —
    // a constant structure with no echo of scope strings. Non-leak is
    // inherently satisfied; checking short generated strings against the
    // serialized constant would produce false positives (e.g. "c" is a
    // substring of "insufficient_scope").
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('insufficient_scope')
  },
)

// ── Factory validation ───────────────────────────────────────────────────────

describe('createOAuthJwtValidator — factory validation', () => {
  it('empty issuer throws at construction', () => {
    expect(() =>
      createOAuthJwtValidator({
        issuer: '',
        audience: TEST_AUDIENCE,
        keyResolver: makeDefaultResolver(),
      }),
    ).toThrow()
  })

  it('empty audience string throws at construction', () => {
    expect(() =>
      createOAuthJwtValidator({
        issuer: TEST_ISSUER,
        audience: '',
        keyResolver: makeDefaultResolver(),
      }),
    ).toThrow()
  })

  it('empty audience array throws at construction', () => {
    expect(() =>
      createOAuthJwtValidator({
        issuer: TEST_ISSUER,
        audience: [],
        keyResolver: makeDefaultResolver(),
      }),
    ).toThrow()
  })

  it('whitespace-only issuer throws at construction', () => {
    expect(() =>
      createOAuthJwtValidator({
        issuer: '   ',
        audience: TEST_AUDIENCE,
        keyResolver: makeDefaultResolver(),
      }),
    ).toThrow()
  })

  it('whitespace-only audience string throws at construction', () => {
    expect(() =>
      createOAuthJwtValidator({
        issuer: TEST_ISSUER,
        audience: '   ',
        keyResolver: makeDefaultResolver(),
      }),
    ).toThrow()
  })

  it('audience array with blank entry throws at construction', () => {
    expect(() =>
      createOAuthJwtValidator({
        issuer: TEST_ISSUER,
        audience: ['valid-aud', '   '],
        keyResolver: makeDefaultResolver(),
      }),
    ).toThrow()
  })
})

// ── Integration: strategy + validator ────────────────────────────────────────

describe('createOAuthResourceServerAuthStrategy + createOAuthJwtValidator — integration', () => {
  function makeApp(requiredScopes: Parameters<typeof createAsyncAuthStrategyMiddleware>[0]['requiredScopes']) {
    const strategy = createOAuthResourceServerAuthStrategy({
      validator: makeValidator(),
    })
    const app = new Hono()
    app.use('*', createAsyncAuthStrategyMiddleware({ strategy, requiredScopes }))
    app.get('/api/x', (c) => c.text('downstream'))
    return app
  }

  it('valid token + required scope in Bearer header → 200 downstream', async () => {
    const token = await buildToken({ scope: 'canvas:read' })
    const app = makeApp(['canvas:read'])
    const res = await app.request('/api/x', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it('valid token missing required scope → 403 auth.forbidden', async () => {
    const token = await buildToken({ scope: 'canvas:read' })
    const app = makeApp(['canvas:write'])
    const res = await app.request('/api/x', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'auth.forbidden' })
  })

  it('invalid signature → 401 auth.required', async () => {
    const token = await buildToken({ scope: 'canvas:read' })
    const parts = token.split('.')
    parts[2] = parts[2].slice(0, -4) + 'XXXX'
    const tampered = parts.join('.')

    const app = makeApp(['canvas:read'])
    const res = await app.request('/api/x', {
      headers: { authorization: `Bearer ${tampered}` },
    })
    expect(res.status).toBe(401)
    const body = await res.text()
    expect(body).toBe('{"error":"auth.required"}')
  })

  it('failure response body does not contain the raw JWT token', async () => {
    const token = await buildToken({ scope: 'canvas:read' })
    const parts = token.split('.')
    parts[2] = parts[2].slice(0, -4) + 'XXXX'
    const tampered = parts.join('.')

    const app = makeApp(['canvas:read'])
    const res = await app.request('/api/x', {
      headers: { authorization: `Bearer ${tampered}` },
    })
    const body = await res.text()
    expect(body).not.toContain(tampered)
    expect(body).not.toContain('eyJ')
    expect(body).not.toContain('Bearer')
  })
})
