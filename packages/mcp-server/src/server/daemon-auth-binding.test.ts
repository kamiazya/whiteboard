import { describe, expect, it } from 'vitest'
import {
  assertLoopbackBindHost,
  buildDaemonBaseUrl,
  formatHostForUrl,
  isLoopbackHost,
  normalizeBindHost,
} from './daemon-auth-binding.js'

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

describe('formatHostForUrl', () => {
  it('brackets a bare IPv6 literal so new URL() can parse the authority', () => {
    // The inverse of normalizeBindHost: server.listen() wants '::1', but a
    // URL authority requires the RFC 3986 §3.2.2 bracketed form — without
    // this, `new URL('http://::1:3099')` throws Invalid URL.
    expect(formatHostForUrl('::1')).toBe('[::1]')
    expect(() => new URL(`http://${formatHostForUrl('::1')}:3099`)).not.toThrow()
  })

  it.each(['127.0.0.1', 'localhost', '0.0.0.0'])('passes %s through unchanged', (host) => {
    expect(formatHostForUrl(host)).toBe(host)
  })
})

describe('buildDaemonBaseUrl', () => {
  // This is the exact composition wb_pairing_link_create's daemonBaseUrl
  // wiring relies on (http-server.ts) — pinning it here catches a wrong
  // interpolation or a dropped formatHostForUrl call even where a real
  // IPv6 bind is unavailable (e.g. an IPv6-disabled sandbox/container).
  it('composes a well-formed, parseable origin for an IPv4 host', () => {
    const url = buildDaemonBaseUrl('127.0.0.1', 3099)
    expect(url).toBe('http://127.0.0.1:3099')
    expect(new URL(url).origin).toBe('http://127.0.0.1:3099')
  })

  it('brackets an IPv6 loopback host so the composed origin is parseable', () => {
    const url = buildDaemonBaseUrl('::1', 3099)
    expect(url).toBe('http://[::1]:3099')
    // WHATWG URL keeps the brackets in .hostname for an IPv6 authority.
    expect(new URL(url).hostname).toBe('[::1]')
    expect(new URL(url).port).toBe('3099')
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
