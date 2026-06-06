import { describe, expect, it } from 'vitest'
import {
  appendVary,
  isLoopbackHostname,
  normalizeOriginHostname,
} from './cors-loopback.js'

describe('isLoopbackHostname', () => {
  it('recognises localhost', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
  })

  it('recognises 127.0.0.1', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
  })

  it('recognises ::1', () => {
    expect(isLoopbackHostname('::1')).toBe(true)
  })

  it('rejects an external hostname', () => {
    expect(isLoopbackHostname('evil.example')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isLoopbackHostname('')).toBe(false)
  })
})

describe('normalizeOriginHostname', () => {
  it('returns hostname from a valid origin', () => {
    expect(normalizeOriginHostname('http://localhost:5173')).toBe('localhost')
  })

  it('returns hostname for 127.0.0.1', () => {
    expect(normalizeOriginHostname('http://127.0.0.1:3099')).toBe('127.0.0.1')
  })

  it('returns null for undefined', () => {
    expect(normalizeOriginHostname(undefined)).toBeNull()
  })

  it('returns null for a malformed origin', () => {
    expect(normalizeOriginHostname('not-a-url')).toBeNull()
  })

  it('returns hostname for an external origin', () => {
    expect(normalizeOriginHostname('https://evil.example')).toBe('evil.example')
  })

  it('returns bare ::1 for an IPv6 loopback origin', () => {
    // new URL('http://[::1]:5173').hostname returns '[::1]' (with brackets).
    // normalizeOriginHostname must strip the brackets so isLoopbackHostname
    // can match against '::1'.
    expect(normalizeOriginHostname('http://[::1]:5173')).toBe('::1')
  })
})

describe('isLoopbackHostname + normalizeOriginHostname integration', () => {
  it('accepts an IPv6 loopback origin through the full pipeline', () => {
    const hostname = normalizeOriginHostname('http://[::1]:5173')
    expect(hostname).not.toBeNull()
    expect(isLoopbackHostname(hostname!)).toBe(true)
  })

  it('accepts an IPv4-mapped loopback origin through the full pipeline', () => {
    const hostname = normalizeOriginHostname('http://127.0.0.1:5173')
    expect(hostname).not.toBeNull()
    expect(isLoopbackHostname(hostname!)).toBe(true)
  })
})

describe('appendVary', () => {
  it('returns the token when value is empty', () => {
    expect(appendVary('', 'Origin')).toBe('Origin')
  })

  it('returns the token when value is null', () => {
    expect(appendVary(null, 'Origin')).toBe('Origin')
  })

  it('appends the token to an existing value', () => {
    expect(appendVary('Accept', 'Origin')).toBe('Accept, Origin')
  })

  it('does not duplicate an already-present token', () => {
    expect(appendVary('Accept, Origin', 'Origin')).toBe('Accept, Origin')
  })

  it('trims whitespace from parts', () => {
    expect(appendVary('Accept , Content-Type', 'Origin')).toBe(
      'Accept, Content-Type, Origin',
    )
  })
})
