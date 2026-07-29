import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  type AsyncAuthStrategy,
  createAsyncAuthStrategyMiddleware,
  createOAuthResourceServerAuthStrategy,
  type OAuthResourceTokenValidationInput,
  type OAuthResourceTokenValidationResult,
  type OAuthResourceTokenValidator,
} from './oauth-resource-strategy.js'

function makeFakeValidator(result: OAuthResourceTokenValidationResult): {
  validator: OAuthResourceTokenValidator
  calls: OAuthResourceTokenValidationInput[]
} {
  const calls: OAuthResourceTokenValidationInput[] = []
  return {
    validator: {
      async validate(input) {
        calls.push(input)
        return result
      },
    },
    calls,
  }
}

describe('createOAuthResourceServerAuthStrategy — header parsing', () => {
  // The strategy reuses the strict `parseBearerAuthorizationHeader`
  // from `routes/auth.ts`, so query/body tokens, lowercase scheme,
  // extra whitespace, comma-joined duplicate Authorization headers,
  // and other malformed shapes are all rejected before the validator
  // is even consulted.

  it('rejects missing Authorization header → 401 auth.required (validator never invoked)', async () => {
    const { validator, calls } = makeFakeValidator({
      ok: true,
      subject: 'sub-1',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: ['canvas:read'],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'GET',
      path: '/api/x',
      requiredScopes: ['canvas:read'],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.status).toBe(401)
      expect(decision.code).toBe('auth.required')
    }
    expect(calls).toHaveLength(0)
  })

  it.each([
    'bearer x',
    'Basic x',
    'Bearer',
    'Bearer ',
    'Bearer  abc',
    'Bearer abc extra',
    'Bearer "abc"',
    'Bearer abc,def',
  ])('rejects malformed Authorization header %j → 401 (validator never invoked)', async (header) => {
    const { validator, calls } = makeFakeValidator({
      ok: true,
      subject: 'sub-1',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: ['canvas:read'],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'GET',
      path: '/api/x',
      authorizationHeader: header,
      requiredScopes: ['canvas:read'],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.status).toBe(401)
    expect(calls).toHaveLength(0)
  })
})

describe('createOAuthResourceServerAuthStrategy — validator success path', () => {
  it('passes the parsed token + requiredScopes to the validator (verbatim)', async () => {
    const { validator, calls } = makeFakeValidator({
      ok: true,
      subject: 'sub-1',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: ['canvas:read', 'canvas:write'],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    await strategy.authorize({
      method: 'POST',
      path: '/api/x',
      authorizationHeader: 'Bearer eyJraWQiOiIxIn0.payload.sig',
      requiredScopes: ['canvas:read'],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].token).toBe('eyJraWQiOiIxIn0.payload.sig')
    expect(calls[0].requiredScopes).toEqual(['canvas:read'])
  })

  it('returns ok with oauth-resource-server context when validator succeeds and scopes satisfy required', async () => {
    const { validator } = makeFakeValidator({
      ok: true,
      subject: 'user-42',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: ['canvas:read', 'canvas:write'],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'POST',
      path: '/api/canvases',
      authorizationHeader: 'Bearer eyJ.payload.sig',
      requiredScopes: ['canvas:write'],
    })
    expect(decision.ok).toBe(true)
    if (decision.ok) {
      expect(decision.context.kind).toBe('oauth-resource-server')
      if (decision.context.kind === 'oauth-resource-server') {
        expect(decision.context.subject).toBe('user-42')
        expect(decision.context.scopes).toEqual(['canvas:read', 'canvas:write'])
      }
    }
  })

  it('does not leak the raw token, issuer URL, or audience into the auth context', async () => {
    const ISSUER = 'https://idp.example/oauth2/v1'
    const AUDIENCE = 'whiteboard-internal-resource-id'
    const { validator } = makeFakeValidator({
      ok: true,
      subject: 'user-42',
      issuer: ISSUER,
      audience: AUDIENCE,
      scopes: ['canvas:read'],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'GET',
      path: '/api/x',
      authorizationHeader: 'Bearer eyJ.canary-token-XYZ.sig',
      requiredScopes: ['canvas:read'],
    })
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain('canary-token-XYZ')
    expect(serialized).not.toContain('eyJ')
    // Issuer and audience are validator-internal; they should not
    // surface in the auth context (subject + scopes only, per the
    // existing AuthContext shape for `oauth-resource-server`).
    expect(serialized).not.toContain(ISSUER)
    expect(serialized).not.toContain(AUDIENCE)
  })
})

describe('createOAuthResourceServerAuthStrategy — defence-in-depth scope subset check', () => {
  // A buggy or compromised validator that returns `ok: true` with
  // scopes narrower than `requiredScopes` must NOT authorize the
  // request. The strategy re-checks subset relation at the boundary.

  it('rejects with 403 auth.forbidden when validator returns ok but granted scopes are insufficient', async () => {
    const { validator } = makeFakeValidator({
      ok: true,
      subject: 'user-42',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: ['canvas:read'], // missing canvas:write
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'POST',
      path: '/api/canvases',
      authorizationHeader: 'Bearer eyJ.payload.sig',
      requiredScopes: ['canvas:write'],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.status).toBe(403)
      expect(decision.code).toBe('auth.forbidden')
    }
  })

  it('rejects with 403 when only some required scopes are present', async () => {
    const { validator } = makeFakeValidator({
      ok: true,
      subject: 'user-42',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: ['canvas:read'],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'POST',
      path: '/api/x',
      authorizationHeader: 'Bearer eyJ.x.y',
      requiredScopes: ['canvas:read', 'canvas:write'],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.status).toBe(403)
  })

  it('accepts when granted scopes are a strict superset of required', async () => {
    const { validator } = makeFakeValidator({
      ok: true,
      subject: 'user-42',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: ['canvas:read', 'canvas:write', 'workspace:write', 'mcp:call'],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'POST',
      path: '/api/x',
      authorizationHeader: 'Bearer eyJ.x.y',
      requiredScopes: ['canvas:read'],
    })
    expect(decision.ok).toBe(true)
  })

  it('accepts when requiredScopes is empty even if granted scopes are also empty (route-level no-op)', async () => {
    const { validator } = makeFakeValidator({
      ok: true,
      subject: 'user-42',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: [],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'GET',
      path: '/api/runtime/ping',
      authorizationHeader: 'Bearer eyJ.x.y',
      requiredScopes: [],
    })
    expect(decision.ok).toBe(true)
  })
})

describe('createOAuthResourceServerAuthStrategy — validator failure mapping', () => {
  // 401 reasons are "credentials missing or invalid; retry with auth".
  // 403 reason is "credentials understood but insufficient scope".
  // The mapping is enumerated explicitly so that adding a new reason
  // requires a deliberate review pass — silent fall-through to a
  // default would let a future reason ship without an HTTP-level
  // decision.

  it.each<[OAuthResourceTokenValidationResult & { ok: false }, 401]>([
    [{ ok: false, reason: 'missing' }, 401],
    [{ ok: false, reason: 'malformed' }, 401],
    [{ ok: false, reason: 'invalid_signature' }, 401],
    [{ ok: false, reason: 'invalid_issuer' }, 401],
    [{ ok: false, reason: 'invalid_audience' }, 401],
    [{ ok: false, reason: 'expired' }, 401],
    [{ ok: false, reason: 'revoked' }, 401],
    [{ ok: false, reason: 'validator_unavailable' }, 401],
    [{ ok: false, reason: 'not_access_token' }, 401],
  ])('maps validator failure %j → status %j', async (result, expectedStatus) => {
    const { validator } = makeFakeValidator(result)
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'GET',
      path: '/api/x',
      authorizationHeader: 'Bearer eyJ.x.y',
      requiredScopes: ['canvas:read'],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.status).toBe(expectedStatus)
      expect(decision.code).toBe('auth.required')
    }
  })

  it('maps validator insufficient_scope → 403 auth.forbidden', async () => {
    const { validator } = makeFakeValidator({ ok: false, reason: 'insufficient_scope' })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'POST',
      path: '/api/x',
      authorizationHeader: 'Bearer eyJ.x.y',
      requiredScopes: ['canvas:write'],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.status).toBe(403)
      expect(decision.code).toBe('auth.forbidden')
    }
  })

  it('does not echo the validator reason or raw token into the failure decision', async () => {
    const { validator } = makeFakeValidator({ ok: false, reason: 'invalid_issuer' })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const decision = await strategy.authorize({
      method: 'GET',
      path: '/api/x',
      authorizationHeader: 'Bearer eyJ.canary-token-XYZ.sig',
      requiredScopes: [],
    })
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain('invalid_issuer')
    expect(serialized).not.toContain('canary-token-XYZ')
    expect(serialized).not.toContain('eyJ')
  })
})

describe('createAsyncAuthStrategyMiddleware', () => {
  function makeStrategy(decision: import('./auth-strategy.js').AuthDecision): {
    strategy: AsyncAuthStrategy
    calls: import('./auth-strategy.js').AuthAuthorizeInput[]
  } {
    const calls: import('./auth-strategy.js').AuthAuthorizeInput[] = []
    return {
      strategy: {
        async authorize(input) {
          calls.push(input)
          return decision
        },
      },
      calls,
    }
  }

  it('passes method/path/authorizationHeader/requiredScopes to the async strategy', async () => {
    const { strategy, calls } = makeStrategy({ ok: true, context: { kind: 'anonymous' } })
    const app = new Hono()
    app.use('*', createAsyncAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:write'] }))
    app.get('/api/x', (c) => c.text('ok'))

    await app.request('/api/x', {
      method: 'GET',
      headers: { authorization: 'Bearer eyJ.payload.sig' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].path).toBe('/api/x')
    expect(calls[0].authorizationHeader).toBe('Bearer eyJ.payload.sig')
    expect(calls[0].requiredScopes).toEqual(['canvas:write'])
  })

  it('runs downstream handler when strategy decision is ok', async () => {
    const { strategy } = makeStrategy({
      ok: true,
      context: { kind: 'oauth-resource-server', subject: 'sub-1', scopes: ['canvas:read'] },
    })
    const app = new Hono()
    app.use('*', createAsyncAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:read'] }))
    app.get('/api/x', (c) => c.text('downstream'))

    const res = await app.request('/api/x')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('downstream')
  })

  it('emits HTTP 401 with WWW-Authenticate: Bearer and constant body on 401 decision', async () => {
    const { strategy } = makeStrategy({
      ok: false,
      status: 401,
      code: 'auth.required',
      wwwAuthenticate: 'Bearer',
    })
    const app = new Hono()
    app.use('*', createAsyncAuthStrategyMiddleware({ strategy, requiredScopes: [] }))
    app.get('/api/x', (c) => c.text('downstream'))

    const res = await app.request('/api/x', {
      headers: { authorization: 'Bearer canary-token-XYZ' },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    const body = await res.text()
    expect(body).toBe('{"error":"auth.required"}')
    expect(body).not.toContain('canary-token-XYZ')
  })

  it('emits HTTP 403 WITHOUT WWW-Authenticate on 403 decision (insufficient credentials cannot be retried with a new auth round)', async () => {
    const { strategy } = makeStrategy({ ok: false, status: 403, code: 'auth.forbidden' })
    const app = new Hono()
    app.use('*', createAsyncAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:write'] }))
    app.get('/api/x', (c) => c.text('downstream'))

    const res = await app.request('/api/x', {
      headers: { authorization: 'Bearer x' },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toBeNull()
    expect(await res.text()).toBe('{"error":"auth.forbidden"}')
  })

  it('does NOT call downstream when strategy rejects', async () => {
    let downstreamCalls = 0
    const { strategy } = makeStrategy({
      ok: false,
      status: 401,
      code: 'auth.required',
      wwwAuthenticate: 'Bearer',
    })
    const app = new Hono()
    app.use('*', createAsyncAuthStrategyMiddleware({ strategy, requiredScopes: [] }))
    app.get('/api/x', (c) => {
      downstreamCalls += 1
      return c.text('ran')
    })

    await app.request('/api/x')
    expect(downstreamCalls).toBe(0)
  })
})

describe('createOAuthResourceServerAuthStrategy — validator exception handling', () => {
  it('catches a thrown exception from validator and returns 401 auth.required', async () => {
    const throwingValidator: OAuthResourceTokenValidator = {
      async validate() {
        throw new Error('Network error: ECONNREFUSED https://idp.example/.well-known/jwks.json')
      },
    }
    const strategy = createOAuthResourceServerAuthStrategy({ validator: throwingValidator })
    const decision = await strategy.authorize({
      method: 'GET',
      path: '/api/x',
      authorizationHeader: 'Bearer eyJ.x.y',
      requiredScopes: ['canvas:read'],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.status).toBe(401)
      expect(decision.code).toBe('auth.required')
    }
  })

  it('does not leak exception message, IdP URL, or stack frames into the decision when validator throws', async () => {
    const IDP_URL = 'https://idp.example/.well-known/jwks.json'
    const throwingValidator: OAuthResourceTokenValidator = {
      async validate() {
        throw new Error(`Network error: ECONNREFUSED ${IDP_URL}`)
      },
    }
    const strategy = createOAuthResourceServerAuthStrategy({ validator: throwingValidator })
    const decision = await strategy.authorize({
      method: 'GET',
      path: '/api/x',
      authorizationHeader: 'Bearer eyJ.canary-token-XYZ.sig',
      requiredScopes: ['canvas:read'],
    })
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain('ECONNREFUSED')
    expect(serialized).not.toContain(IDP_URL)
    expect(serialized).not.toContain('canary-token-XYZ')
    expect(serialized).not.toContain('Network error')
  })
})

describe('createOAuthResourceServerAuthStrategy + createAsyncAuthStrategyMiddleware end-to-end', () => {
  it('rejects ?token=<jwt> query string only — header-only auth posture is preserved', async () => {
    const { validator, calls } = makeFakeValidator({
      ok: true,
      subject: 'sub-1',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: ['canvas:read'],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const app = new Hono()
    app.use('*', createAsyncAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:read'] }))
    app.get('/api/x', (c) => c.text('downstream'))

    const res = await app.request('/api/x?token=eyJ.x.y', { method: 'GET' })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('rejects body { token: <jwt> } only — header-only auth posture is preserved', async () => {
    const { validator, calls } = makeFakeValidator({
      ok: true,
      subject: 'sub-1',
      issuer: 'https://idp.example/',
      audience: 'res-1',
      scopes: ['canvas:read'],
    })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const app = new Hono()
    app.use('*', createAsyncAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:read'] }))
    app.post('/api/x', (c) => c.text('downstream'))

    const res = await app.request('/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'eyJ.x.y' }),
    })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('non-leak sweep: response body / headers never carry the canary token, Authorization, or Bearer secret literal', async () => {
    const { validator } = makeFakeValidator({ ok: false, reason: 'invalid_signature' })
    const strategy = createOAuthResourceServerAuthStrategy({ validator })
    const app = new Hono()
    app.use('*', createAsyncAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:read'] }))
    app.get('/api/x', (c) => c.text('downstream'))

    const TOKEN = 'eyJraWQiOiIxIn0.canary-token-XYZ.signaturepart'
    const res = await app.request('/api/x', {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(401)
    const body = await res.text()
    expect(body).not.toContain(TOKEN)
    expect(body).not.toContain('canary-token-XYZ')
    expect(body).not.toContain('eyJraWQ')
    expect(body).not.toContain('Bearer')
    expect(body).not.toContain('Authorization')
    expect(body).not.toContain('invalid_signature')
    // WWW-Authenticate is fixed to bare `Bearer` (no realm, no error,
    // no scope) — widening would require a separate AuthDecision
    // contract change.
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
  })
})
