// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isLoopbackHostname } from './loopback-host.js'

describe('isLoopbackHostname', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts %s', (host) => {
    expect(isLoopbackHostname(host)).toBe(true)
  })

  it.each([
    'localhost.evil.example',
    '127.0.0.1.evil.example',
    '127.0.0.2',
    '0.0.0.0',
    '[::2]',
    'example.com',
    'LOCALHOST',
    '',
  ])('refuses %s', (host) => {
    expect(isLoopbackHostname(host)).toBe(false)
  })

  it('takes the hostname URL reports, which keeps an IPv6 literal bracketed', () => {
    expect(isLoopbackHostname(new URL('http://[::1]:7777').hostname)).toBe(true)
  })
})
