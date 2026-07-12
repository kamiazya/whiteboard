import { describe, expect, it } from 'vitest'
import { isAuthorized, parseBearerAuthorizationHeader, requiresDaemonAuth } from './auth.js'

describe('requiresDaemonAuth', () => {
  it('default-requires bearer auth for every /api method, not just mutations', () => {
    expect(requiresDaemonAuth('/api/workspaces/session-1/canvases')).toBe(true)
    expect(requiresDaemonAuth('/api/brand-new-mutation')).toBe(true)
    // Canvas/asset reads are covered too: ADR-0002's read carve-out assumed a
    // hosted origin could never reach the daemon, which ADR-0005 retires. The
    // client already sends the bearer on every read (apiFetch, and every image
    // consumer fetches+blobs instead of using a bare <img src>), so requiring
    // it server-side costs nothing on the happy path and closes the
    // read-without-a-token surface for anyone else.
    expect(requiresDaemonAuth('/api/workspaces')).toBe(true)
    expect(requiresDaemonAuth('/api/canvas/session-1/demo/snapshot')).toBe(true)
    expect(
      requiresDaemonAuth('/api/workspaces/session-1/canvases/demo/versions/v1/thumbnail'),
    ).toBe(true)
    expect(requiresDaemonAuth('/api/canvas/session-1/demo/file/f1')).toBe(true)
  })

  it('allows only /api/runtime/ping to bypass the middleware', () => {
    expect(requiresDaemonAuth('/api/runtime/ping')).toBe(false)
    expect(requiresDaemonAuth('/api/runtime/status')).toBe(true)
    expect(requiresDaemonAuth('/api/runtime/touch')).toBe(true)
    expect(requiresDaemonAuth('/api/runtime/shutdown')).toBe(true)
    expect(requiresDaemonAuth('/api/runtime/brand-new')).toBe(true)
  })

  it('leaves non-/api paths alone', () => {
    expect(requiresDaemonAuth('/canvas/session-1/demo')).toBe(false)
    expect(requiresDaemonAuth('/')).toBe(false)
  })
})

describe('parseBearerAuthorizationHeader', () => {
  it.each([
    ['Bearer eyJraWQiOiIxIn0.payload.sig', 'eyJraWQiOiIxIn0.payload.sig'],
    ['Bearer abc123', 'abc123'],
  ])('accepts well-formed header %j → %j', (header, expected) => {
    expect(parseBearerAuthorizationHeader(header)).toBe(expected)
  })

  it.each([
    undefined,
    '',
    'bearer abc',
    'Basic abc',
    'Bearer',
    'Bearer ',
    'Bearer  abc',
    'Bearer abc extra',
    'Bearer abc,def',
    'Bearer "abc"',
    'Bearer abc\tabc',
  ])('rejects malformed / missing header %j → null', (header) => {
    expect(parseBearerAuthorizationHeader(header)).toBeNull()
  })
})

describe('isAuthorized', () => {
  it('treats undefined token as compatibility mode', () => {
    expect(isAuthorized(undefined, undefined)).toBe(true)
    expect(isAuthorized('Bearer anything', undefined)).toBe(true)
  })

  it('requires a strict Bearer token match when configured', () => {
    expect(isAuthorized(undefined, 'secret')).toBe(false)
    expect(isAuthorized('Bearer nope', 'secret')).toBe(false)
    expect(isAuthorized('Bearer secret', 'secret')).toBe(true)
  })

  it('rejects malformed Bearer headers even when token matches literal suffix', () => {
    expect(isAuthorized('bearer secret', 'secret')).toBe(false)
    expect(isAuthorized('Bearer  secret', 'secret')).toBe(false)
    expect(isAuthorized('Bearer secret extra', 'secret')).toBe(false)
  })
})
