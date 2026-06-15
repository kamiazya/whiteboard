import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  type AuthAuthorizeInput,
  type AuthDecision,
  type AuthStrategy,
  createAuthStrategyMiddleware,
  createLocalTokenAuthStrategy,
} from './auth-strategy.js'

describe('createLocalTokenAuthStrategy', () => {
  // Behavior parity with the legacy `isAuthorized()` rule in
  // `routes/auth.ts` is the regression contract. The strategy is a
  // typed wrapper around that semantics; if the strategy ever
  // diverges, the existing daemon mutation auth middleware would too.

  it('allows requests when no token is configured — local daemon no-auth concession (anonymous context)', () => {
    const strategy = createLocalTokenAuthStrategy({})
    const decision = strategy.authorize({
      method: 'GET',
      path: '/api/workspaces',
      requiredScopes: [],
    })
    expect(decision.ok).toBe(true)
    if (decision.ok) {
      expect(decision.context.kind).toBe('anonymous')
    }
  })

  it('allows requests with a correct Bearer token (local-token context)', () => {
    const strategy = createLocalTokenAuthStrategy({ token: 'secret' })
    const decision = strategy.authorize({
      method: 'POST',
      path: '/api/workspaces/x/canvases',
      authorizationHeader: 'Bearer secret',
      requiredScopes: ['canvas:write'],
    })
    expect(decision.ok).toBe(true)
    if (decision.ok) {
      expect(decision.context.kind).toBe('local-token')
    }
  })

  it('rejects when token is configured but Authorization header is missing → 401 auth.required', () => {
    const strategy = createLocalTokenAuthStrategy({ token: 'secret' })
    const decision = strategy.authorize({
      method: 'POST',
      path: '/api/workspaces/x/canvases',
      requiredScopes: ['canvas:write'],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.status).toBe(401)
      expect(decision.code).toBe('auth.required')
    }
  })

  it('rejects when Bearer value does not match the configured token → 401', () => {
    const strategy = createLocalTokenAuthStrategy({ token: 'secret' })
    const decision = strategy.authorize({
      method: 'POST',
      path: '/api/workspaces/x/canvases',
      authorizationHeader: 'Bearer not-the-token',
      requiredScopes: ['canvas:write'],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.status).toBe(401)
    }
  })

  it.each([
    'bearer secret', // wrong case — `safeStringEqual` is case-sensitive
    'Basic secret',
    'Bearer',
    'Bearer ',
    'secret',
    '',
  ])('rejects malformed Authorization header %j → 401', (header) => {
    const strategy = createLocalTokenAuthStrategy({ token: 'secret' })
    const decision = strategy.authorize({
      method: 'POST',
      path: '/api/x',
      authorizationHeader: header,
      requiredScopes: [],
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.status).toBe(401)
    }
  })

  it('local-token success path ignores requiredScopes — server-mode scope enforcement is the future strategy responsibility, not the local-token wrapper', () => {
    const strategy = createLocalTokenAuthStrategy({ token: 'secret' })
    const decision = strategy.authorize({
      method: 'POST',
      path: '/api/anything',
      authorizationHeader: 'Bearer secret',
      requiredScopes: [
        'canvas:write',
        'workspace:write',
        'versions:write',
        'files:write',
        'runtime:admin',
        'mcp:call',
      ],
    })
    expect(decision.ok).toBe(true)
  })
})

describe('createLocalTokenAuthStrategy non-leak guard', () => {
  // Operator output is captured by smoke runs, support bundles, and
  // CI logs. A leak of the token literal, the Authorization header,
  // a local file path, or a stack frame onto a user-facing decision
  // would put secrets and host internals on those surfaces.

  it('a wrong-bearer rejection never carries the token literal, the wrong-bearer literal, or path internals', () => {
    const token = 'secret-token-XYZ'
    const wrongBearer = `Bearer wrong-${token}`
    const strategy = createLocalTokenAuthStrategy({ token })
    const decision = strategy.authorize({
      method: 'POST',
      path: '/opt/whiteboard/internal/file.ts:42',
      authorizationHeader: wrongBearer,
      requiredScopes: ['canvas:write'],
    })
    expect(decision.ok).toBe(false)
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('wrong-')
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('/opt/')
    expect(serialized).not.toMatch(/\.ts:\d+/)
  })

  it('a missing-header rejection never includes the path or scopes verbatim', () => {
    const strategy = createLocalTokenAuthStrategy({ token: 'secret' })
    const decision = strategy.authorize({
      method: 'POST',
      path: '/api/workspaces/secret-workspace-id/canvases',
      requiredScopes: ['canvas:write'],
    })
    expect(decision.ok).toBe(false)
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain('secret-workspace-id')
  })
})

describe('createAuthStrategyMiddleware', () => {
  function makeFakeStrategy(decision: AuthDecision): {
    strategy: AuthStrategy
    calls: AuthAuthorizeInput[]
  } {
    const calls: AuthAuthorizeInput[] = []
    return {
      strategy: {
        authorize(input) {
          calls.push(input)
          return decision
        },
      },
      calls,
    }
  }

  it('passes method, path, authorizationHeader, and requiredScopes through to the strategy', async () => {
    const { strategy, calls } = makeFakeStrategy({
      ok: true,
      context: { kind: 'anonymous' },
    })
    const app = new Hono()
    app.use(
      '*',
      createAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:write', 'files:read'] }),
    )
    app.get('/api/x', (c) => c.text('ok'))

    await app.request('/api/x', {
      method: 'GET',
      headers: { authorization: 'Bearer secret-token-XYZ' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].path).toBe('/api/x')
    expect(calls[0].authorizationHeader).toBe('Bearer secret-token-XYZ')
    expect(calls[0].requiredScopes).toEqual(['canvas:write', 'files:read'])
  })

  it('runs the downstream handler when the strategy returns ok', async () => {
    const { strategy } = makeFakeStrategy({ ok: true, context: { kind: 'local-token' } })
    const app = new Hono()
    app.use('*', createAuthStrategyMiddleware({ strategy, requiredScopes: [] }))
    app.get('/api/x', (c) => c.text('downstream-ran'))

    const res = await app.request('/api/x', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('downstream-ran')
  })

  it('returns HTTP 401 with safe body and WWW-Authenticate on a 401 auth.required decision', async () => {
    const { strategy } = makeFakeStrategy({
      ok: false,
      status: 401,
      code: 'auth.required',
      wwwAuthenticate: 'Bearer',
    })
    const app = new Hono()
    app.use('*', createAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:write'] }))
    app.get('/api/x', (c) => c.text('downstream-must-not-run'))

    const token = 'secret-token-XYZ'
    const res = await app.request('/api/x', {
      method: 'GET',
      headers: { authorization: `Bearer wrong-${token}` },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    const body = await res.text()
    expect(body).not.toContain(token)
    expect(body).not.toContain('wrong-')
    expect(body).not.toContain('Bearer wrong')
    expect(body).toContain('auth.required')
  })

  it('returns HTTP 403 with safe body and no WWW-Authenticate on a 403 auth.forbidden decision', async () => {
    const { strategy } = makeFakeStrategy({
      ok: false,
      status: 403,
      code: 'auth.forbidden',
    })
    const app = new Hono()
    app.use('*', createAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:write'] }))
    app.get('/api/x', (c) => c.text('downstream-must-not-run'))

    const res = await app.request('/api/x', {
      method: 'GET',
      headers: { authorization: 'Bearer something' },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toBeNull()
    const body = await res.text()
    expect(body).toContain('auth.forbidden')
    expect(body).not.toContain('something')
  })

  it('does NOT call downstream when the strategy rejects', async () => {
    let downstreamCalls = 0
    const { strategy } = makeFakeStrategy({
      ok: false,
      status: 401,
      code: 'auth.required',
      wwwAuthenticate: 'Bearer',
    })
    const app = new Hono()
    app.use('*', createAuthStrategyMiddleware({ strategy, requiredScopes: [] }))
    app.get('/api/x', (c) => {
      downstreamCalls += 1
      return c.text('ran')
    })

    await app.request('/api/x', { method: 'GET' })
    expect(downstreamCalls).toBe(0)
  })
})

describe('AuthDecision failure-variant contract (compile-time regression)', () => {
  // The failure shape pins (status, code, wwwAuthenticate) 1:1.
  // These `@ts-expect-error` lines fail the typecheck step if the
  // contract loosens — that's the regression. The lines below must
  // each be a *type error*, otherwise the typecheck guard is gone.

  it('rejects { status: 401, code: "auth.forbidden" } at the type level', () => {
    // @ts-expect-error 401 must pair with code 'auth.required'
    const bad: AuthDecision = {
      ok: false,
      status: 401,
      code: 'auth.forbidden',
      wwwAuthenticate: 'Bearer',
    }
    expect(bad.ok).toBe(false)
  })

  it('rejects { status: 403, code: "auth.required" } at the type level', () => {
    // @ts-expect-error 403 must pair with code 'auth.forbidden'
    const bad: AuthDecision = {
      ok: false,
      status: 403,
      code: 'auth.required',
    }
    expect(bad.ok).toBe(false)
  })

  it('rejects a 403 decision that carries a WWW-Authenticate challenge', () => {
    // @ts-expect-error 403 cannot carry wwwAuthenticate (no challenge on insufficient credentials)
    const bad: AuthDecision = {
      ok: false,
      status: 403,
      code: 'auth.forbidden',
      wwwAuthenticate: 'Bearer',
    }
    expect(bad.ok).toBe(false)
  })

  it('rejects a 401 decision that omits the WWW-Authenticate challenge', () => {
    // @ts-expect-error 401 must carry wwwAuthenticate per RFC 7235
    const bad: AuthDecision = {
      ok: false,
      status: 401,
      code: 'auth.required',
    }
    expect(bad.ok).toBe(false)
  })

  it('rejects a 401 decision whose wwwAuthenticate widens beyond the "Bearer" literal', () => {
    // @ts-expect-error wwwAuthenticate is a literal 'Bearer' on the 401 variant
    const bad: AuthDecision = {
      ok: false,
      status: 401,
      code: 'auth.required',
      wwwAuthenticate: 'Bearer realm="local-daemon"',
    }
    expect(bad.ok).toBe(false)
  })
})

describe('createAuthStrategyMiddleware 401/403 challenge-header regression (runtime)', () => {
  it('a 401 decision always emits WWW-Authenticate: Bearer (not gated on a wider truthy check)', async () => {
    const strategy: AuthStrategy = {
      authorize: () => ({
        ok: false,
        status: 401,
        code: 'auth.required',
        wwwAuthenticate: 'Bearer',
      }),
    }
    const app = new Hono()
    app.use('*', createAuthStrategyMiddleware({ strategy, requiredScopes: [] }))
    app.get('/api/x', (c) => c.text('downstream'))

    const res = await app.request('/api/x', { method: 'GET' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('a 403 decision never emits WWW-Authenticate (insufficient credentials → no challenge)', async () => {
    const strategy: AuthStrategy = {
      authorize: () => ({ ok: false, status: 403, code: 'auth.forbidden' }),
    }
    const app = new Hono()
    app.use('*', createAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:write'] }))
    app.get('/api/x', (c) => c.text('downstream'))

    const res = await app.request('/api/x', { method: 'GET' })
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })
})

describe('createAuthStrategyMiddleware end-to-end with createLocalTokenAuthStrategy', () => {
  // Existing daemon mutation auth uses `isAuthorized()` directly. The
  // new strategy wrapper must produce the same accept/reject decisions
  // for the same (token, header) combinations so that adopting the
  // strategy in routes does not change runtime behavior.

  it('tokenless local daemon: every request reaches the downstream handler', async () => {
    const strategy = createLocalTokenAuthStrategy({})
    const app = new Hono()
    app.use('*', createAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:write'] }))
    app.get('/api/x', (c) => c.text('ok'))
    app.post('/api/y', (c) => c.text('ok'))

    expect((await app.request('/api/x')).status).toBe(200)
    expect((await app.request('/api/y', { method: 'POST' })).status).toBe(200)
  })

  it('configured token: correct Bearer reaches downstream, wrong/missing Bearer is rejected with 401 and safe body', async () => {
    const strategy = createLocalTokenAuthStrategy({ token: 'secret' })
    const app = new Hono()
    app.use('*', createAuthStrategyMiddleware({ strategy, requiredScopes: ['canvas:write'] }))
    app.post('/api/x', (c) => c.text('ok'))

    const ok = await app.request('/api/x', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    })
    expect(ok.status).toBe(200)

    const missing = await app.request('/api/x', { method: 'POST' })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')

    const wrong = await app.request('/api/x', {
      method: 'POST',
      headers: { authorization: 'Bearer not-secret' },
    })
    expect(wrong.status).toBe(401)
    const wrongBody = await wrong.text()
    expect(wrongBody).not.toContain('secret')
    expect(wrongBody).not.toContain('not-secret')
  })
})
