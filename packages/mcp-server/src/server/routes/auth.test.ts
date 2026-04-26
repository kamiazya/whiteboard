import { describe, expect, it } from 'vitest'
import {
  isAuthorized,
  requiresDaemonMutationAuth,
} from './auth.js'

describe('requiresDaemonMutationAuth', () => {
  it('default-denies mutating /api requests outside the explicit allowlist', () => {
    expect(requiresDaemonMutationAuth('POST', '/api/workspaces/session-1/canvases')).toBe(true)
    expect(requiresDaemonMutationAuth('PATCH', '/api/brand-new-mutation')).toBe(true)
    expect(requiresDaemonMutationAuth('DELETE', '/api/anything')).toBe(true)
  })

  it('keeps read-only requests public', () => {
    expect(requiresDaemonMutationAuth('GET', '/api/workspaces')).toBe(false)
    expect(requiresDaemonMutationAuth('HEAD', '/api/workspaces')).toBe(false)
  })

  it('allows only the explicit runtime exception routes to bypass the middleware', () => {
    expect(requiresDaemonMutationAuth('GET', '/api/runtime/ping')).toBe(false)
    expect(requiresDaemonMutationAuth('POST', '/api/runtime/touch')).toBe(false)
    expect(requiresDaemonMutationAuth('POST', '/api/runtime/shutdown')).toBe(false)
    expect(requiresDaemonMutationAuth('POST', '/api/runtime/brand-new')).toBe(false)
  })
})

describe('isAuthorized', () => {
  it('treats undefined token as compatibility mode', () => {
    expect(isAuthorized(undefined, undefined)).toBe(true)
    expect(isAuthorized('Bearer anything', undefined)).toBe(true)
  })

  it('requires an exact bearer token match when configured', () => {
    expect(isAuthorized(undefined, 'secret')).toBe(false)
    expect(isAuthorized('Bearer nope', 'secret')).toBe(false)
    expect(isAuthorized('Bearer secret', 'secret')).toBe(true)
  })
})
