import { describe, expect, it } from 'vitest'
import { isLoopbackHost } from './daemon-auth-binding.js'

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
