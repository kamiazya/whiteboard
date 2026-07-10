import { describe, expect, it } from 'vitest'

import { isAllowedMcpHttpOrigin, requiresMcpHttpAuth } from './mcp-http.js'

describe('MCP HTTP security', () => {
  describe('isAllowedMcpHttpOrigin', () => {
    it('allows requests without Origin when the request host is loopback', () => {
      expect(isAllowedMcpHttpOrigin(undefined, '127.0.0.1:3099')).toBe(true)
      expect(isAllowedMcpHttpOrigin(undefined, 'localhost:3099')).toBe(true)
    })

    it('rejects requests whose host is not loopback', () => {
      expect(isAllowedMcpHttpOrigin(undefined, 'evil.example')).toBe(false)
      expect(isAllowedMcpHttpOrigin('http://127.0.0.1:6274', 'evil.example')).toBe(false)
    })

    it('allows loopback browser origins for loopback hosts', () => {
      expect(isAllowedMcpHttpOrigin('http://127.0.0.1:6274', '127.0.0.1:3099')).toBe(true)
      expect(isAllowedMcpHttpOrigin('http://localhost:6274', '127.0.0.1:3099')).toBe(true)
      expect(isAllowedMcpHttpOrigin('http://127.0.0.1:6274', 'localhost:3099')).toBe(true)
    })

    it('rejects non-loopback browser origins', () => {
      expect(isAllowedMcpHttpOrigin('https://evil.example', '127.0.0.1:3099')).toBe(false)
      expect(isAllowedMcpHttpOrigin('null', '127.0.0.1:3099')).toBe(false)
    })

    it('allows requests with IPv6 loopback Host header', () => {
      // RFC 7230 §2.7.1 / WHATWG URL: the Host header for IPv6 uses brackets
      // e.g. "[::1]:3099". normalizeHostname must strip brackets before
      // isLoopbackHostname can match the bare "::1" address.
      expect(isAllowedMcpHttpOrigin(undefined, '[::1]:3099')).toBe(true)
      expect(isAllowedMcpHttpOrigin('http://[::1]:6274', '[::1]:3099')).toBe(true)
    })

    describe('with an allowedOrigins allowlist', () => {
      const allowlist = ['https://kamiazya-whiteboard.pages.dev']

      it('admits an exact allowlisted hosted origin for a loopback host', () => {
        expect(
          isAllowedMcpHttpOrigin(
            'https://kamiazya-whiteboard.pages.dev',
            '127.0.0.1:3099',
            allowlist,
          ),
        ).toBe(true)
      })

      it('still requires a loopback Host even for an allowlisted origin', () => {
        expect(
          isAllowedMcpHttpOrigin(
            'https://kamiazya-whiteboard.pages.dev',
            'evil.example',
            allowlist,
          ),
        ).toBe(false)
      })

      it('rejects a lookalike origin not in the allowlist', () => {
        expect(
          isAllowedMcpHttpOrigin(
            'https://evil-kamiazya-whiteboard.pages.dev',
            '127.0.0.1:3099',
            allowlist,
          ),
        ).toBe(false)
      })

      it('defaults to empty allowlist and preserves prior 403 behavior', () => {
        expect(
          isAllowedMcpHttpOrigin('https://kamiazya-whiteboard.pages.dev', '127.0.0.1:3099'),
        ).toBe(false)
      })
    })
  })

  describe('requiresMcpHttpAuth', () => {
    it('requires auth for MCP HTTP requests except preflight', () => {
      expect(requiresMcpHttpAuth('GET')).toBe(true)
      expect(requiresMcpHttpAuth('POST')).toBe(true)
      expect(requiresMcpHttpAuth('DELETE')).toBe(true)
      expect(requiresMcpHttpAuth('OPTIONS')).toBe(false)
    })
  })
})
