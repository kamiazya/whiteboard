import { describe, expect, it } from 'vitest'
import { isAuthorized, parseBearerAuthorizationHeader } from './bearer-token.js'

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
