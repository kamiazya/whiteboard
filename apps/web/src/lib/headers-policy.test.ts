// @vitest-environment node
import {
  FONT_CATALOGUE,
  FONT_SOURCE_ORIGIN,
  fontDownloadUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import { describe, expect, it } from 'vitest'
import appsWebPkgRaw from '../../package.json?raw'
import headersContent from '../../public/_headers?raw'

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

  it("contains form-action 'none'", () => {
    // The app submits no form natively (every <form> preventDefaults), so a
    // form that markup injected into the page could build has nowhere to post.
    expect(extractCsp(headersContent)).toContain("form-action 'none'")
  })

  it("script-src allows WebAssembly compilation via 'wasm-unsafe-eval'", () => {
    // loro-crdt ships as a WebAssembly module. Under script-src 'self' the browser
    // rejects WebAssembly.Module() (CompileError) and the app renders a blank page.
    // 'wasm-unsafe-eval' permits WASM compilation WITHOUT allowing JS eval().
    const csp = extractCsp(headersContent)
    expect(csp).toMatch(/script-src[^;]*'wasm-unsafe-eval'/)
  })

  it("script-src does not contain full 'unsafe-eval'", () => {
    // 'wasm-unsafe-eval' is the narrow carve-out; plain 'unsafe-eval' (JS eval)
    // must never be introduced. The leading quote in the pattern prevents a
    // false match against 'wasm-unsafe-eval'.
    const csp = extractCsp(headersContent)
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/)
  })

  it('connect-src does not contain bare wildcard *', () => {
    const csp = extractCsp(headersContent)
    const connectSrcMatch = /connect-src\s+([^;]*)/.exec(csp)
    if (connectSrcMatch) {
      const tokens = connectSrcMatch[1].trim().split(/\s+/)
      expect(tokens).not.toContain('*')
    }
  })

  function connectSources(): string[] {
    const csp = extractCsp(headersContent)
    return (/connect-src\s+([^;]*)/.exec(csp)?.[1] ?? '').trim().split(/\s+/)
  }

  it('connect-src admits the font catalogue source, and no other third-party source', () => {
    // The web app fetches a theme's family from the catalogue's pinned source
    // when no daemon holds it (ADR-0012, 2026-09-09). The origin is read off
    // the catalogue constant rather than spelled here, so the policy and the
    // fetch cannot drift apart — and it is the ONLY third-party source.
    const thirdParty = connectSources().filter((t) => t.startsWith('https://'))
    expect(thirdParty).toHaveLength(1)
    expect(new URL(thirdParty[0] ?? '').origin).toBe(FONT_SOURCE_ORIGIN)
  })

  it('connect-src scopes the font source to the catalogue path, not the whole origin', () => {
    // The origin serves every public repository on GitHub, so admitting it
    // whole lets injected script read or beacon through any of them. A source
    // ending in `/` matches by path prefix; after a redirect CSP matches the
    // origin alone, so a path scope never breaks a redirected download.
    const source = connectSources().find((t) => t.startsWith('https://')) ?? ''
    expect(source.endsWith('/')).toBe(true)
    expect(new URL(source).pathname).not.toBe('/')
    expect(FONT_CATALOGUE.length).toBeGreaterThan(0)
    for (const entry of FONT_CATALOGUE) {
      expect(fontDownloadUrl(entry).startsWith(source), entry.id).toBe(true)
    }
  })

  it('connect-src admits no loopback origin: a hosted page reaches the daemon through the extension', () => {
    // ADR-0050: the daemon listens on an owner-only socket and the page talks
    // to it through the extension's bridge (a postMessage, not a network
    // request), so the page never needs a loopback http/ws connect target. A
    // loopback source here would only let injected script probe whatever
    // listens on the visitor's machine.
    const tokens = connectSources()
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toBe("'self'")
    expect(new URL(tokens[1] ?? '').origin).toBe(FONT_SOURCE_ORIGIN)
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
// Broader .github/workflows/ scanning lives in tools/arch-lint's web-app-boundary.test.ts.
describe('apps/web config secrets guard', () => {
  it('package.json does not contain Cloudflare production secrets', () => {
    expect(appsWebPkgRaw).not.toContain('CLOUDFLARE_API_TOKEN')
    expect(appsWebPkgRaw).not.toContain('CF_API_TOKEN')
    expect(appsWebPkgRaw).not.toContain('CLOUDFLARE_ACCOUNT_ID')
  })
})
