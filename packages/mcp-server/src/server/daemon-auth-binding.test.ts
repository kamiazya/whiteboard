import { describe, expect, it } from 'vitest'
import { assertLoopbackBindHost, isLoopbackHost, normalizeBindHost } from './daemon-auth-binding.js'

describe('normalizeBindHost', () => {
  it('strips URI brackets from IPv6 so the host is valid for server.listen', () => {
    // The bind guard accepts '[::1]' as loopback, but Node's listen() wants
    // the bare address — passing '[::1]' through crashes with EINVAL.
    expect(normalizeBindHost('[::1]')).toBe('::1')
  })

  it.each(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])('passes %s through unchanged', (host) => {
    expect(normalizeBindHost(host)).toBe(host)
  })
})

// Security-boundary conformance: these cases define what the daemon binding
// considers "loopback-only" for server-mode exposure validation.

describe('isLoopbackHost', () => {
  it.each([
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
  ])('accepts canonical loopback host %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each([
    '0.0.0.0',
    '127.0.0.2',
    '192.168.1.1',
    'localhost:3099', // host + port is not a bare hostname
    'example.com',
    '',
    'LOCALHOST', // case-sensitive: uppercase rejected
    '[::2]',
  ])('rejects non-loopback or malformed host %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})

describe('assertLoopbackBindHost', () => {
  it.each([
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
  ])('allows starting the daemon bound to loopback host %s', (host) => {
    expect(assertLoopbackBindHost(host)).toEqual({ ok: true })
  })

  it.each([
    '0.0.0.0',
    '192.168.1.5',
    'evil.example',
  ])('refuses to start the daemon bound to non-loopback host %s', (host) => {
    expect(assertLoopbackBindHost(host)).toEqual({
      ok: false,
      code: 'bind_host_not_loopback',
    })
  })
})
