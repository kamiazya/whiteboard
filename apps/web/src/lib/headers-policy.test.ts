import { describe, expect, it } from 'vitest'
import headersContent from '../../public/_headers?raw'
import appsWebPkgRaw from '../../package.json?raw'

// Static drift guards for apps/web/public/_headers.
// These tests fix the CSP and security-header contract so that
// mutations (wildcard connect-src, missing directives, leaked tokens)
// are caught before the file reaches Cloudflare Pages.

describe('_headers file exists and is non-empty', () => {
  it('is a non-empty string', () => {
    expect(typeof headersContent).toBe('string')
    expect(headersContent.trim().length).toBeGreaterThan(0)
  })
})

describe('Content-Security-Policy directives', () => {
  function extractCsp(content: string): string {
    const line = content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('Content-Security-Policy:'))
    if (!line) throw new Error('Content-Security-Policy header not found in _headers')
    return line.slice('Content-Security-Policy:'.length).trim()
  }

  it("contains default-src 'self'", () => {
    expect(extractCsp(headersContent)).toContain("default-src 'self'")
  })

  it("contains base-uri 'none'", () => {
    expect(extractCsp(headersContent)).toContain("base-uri 'none'")
  })

  it("contains object-src 'none'", () => {
    expect(extractCsp(headersContent)).toContain("object-src 'none'")
  })

  it("contains frame-ancestors 'none'", () => {
    expect(extractCsp(headersContent)).toContain("frame-ancestors 'none'")
  })

  it('connect-src does not contain bare wildcard *', () => {
    const csp = extractCsp(headersContent)
    const connectSrcMatch = /connect-src\s+([^;]*)/.exec(csp)
    if (connectSrcMatch) {
      const tokens = connectSrcMatch[1].trim().split(/\s+/)
      expect(tokens).not.toContain('*')
    }
  })

  it('connect-src does not contain preview-origin wildcard patterns', () => {
    const csp = extractCsp(headersContent)
    expect(csp).not.toMatch(/connect-src[^;]*\*\.pages\.dev/)
    expect(csp).not.toMatch(/connect-src[^;]*\*\.whiteboard\.pages\.dev/)
  })
})

describe('security headers present', () => {
  it('contains X-Content-Type-Options: nosniff', () => {
    expect(headersContent).toContain('X-Content-Type-Options: nosniff')
  })

  it('contains Referrer-Policy', () => {
    expect(headersContent).toMatch(/Referrer-Policy:/)
  })

  it('contains Permissions-Policy', () => {
    expect(headersContent).toMatch(/Permissions-Policy:/)
  })
})

describe('token / secret leak guard', () => {
  it('_headers contains no Authorization or Bearer tokens', () => {
    expect(headersContent).not.toMatch(/\bAuthorization\b/)
    expect(headersContent).not.toMatch(/\bBearer\b/)
  })

  it('_headers contains no Cloudflare production secrets', () => {
    expect(headersContent).not.toContain('CLOUDFLARE_API_TOKEN')
    expect(headersContent).not.toContain('CF_API_TOKEN')
    expect(headersContent).not.toContain('CLOUDFLARE_ACCOUNT_ID')
  })
})

// Deploy-workflow guard: apps/web config files must not contain production secrets.
// Broader .github/workflows/ scanning lives in packages/mcp-server web-app-boundary.test.ts.
describe('apps/web config secrets guard', () => {
  it('package.json does not contain Cloudflare production secrets', () => {
    expect(appsWebPkgRaw).not.toContain('CLOUDFLARE_API_TOKEN')
    expect(appsWebPkgRaw).not.toContain('CF_API_TOKEN')
    expect(appsWebPkgRaw).not.toContain('CLOUDFLARE_ACCOUNT_ID')
  })
})
