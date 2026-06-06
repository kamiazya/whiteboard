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
