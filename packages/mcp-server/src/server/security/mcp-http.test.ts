import { describe, expect, it } from 'vitest'

import {
  isAllowedMcpHttpOrigin,
  requiresMcpHttpAuth,
} from './mcp-http.js'

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
