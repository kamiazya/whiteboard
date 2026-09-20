import { describe, expect, it } from 'vitest'
import { ALL_AUTH_SCOPES, AUTH_SCOPES, type AuthDecision } from './auth-strategy.js'

describe('ALL_AUTH_SCOPES', () => {
  // ALL_AUTH_SCOPES is handed out wholesale on every accepted WS upgrade.
  // It must always cover exactly the AUTH_SCOPES vocabulary — not a
  // hand-copied literal that can silently drift (under- or over-grant)
  // when a scope is added to one list and forgotten in the other.
  it('contains exactly the same scopes as AUTH_SCOPES, no more and no less', () => {
    expect(new Set(ALL_AUTH_SCOPES)).toEqual(new Set(AUTH_SCOPES))
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
