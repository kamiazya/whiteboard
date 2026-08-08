import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { devHeadersFromCloudflareHeaders } from './vite-dev-headers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const headersText = readFileSync(resolve(__dirname, 'public/_headers'), 'utf8')

// The production `_headers` file only ships on Cloudflare Pages, so a CSP
// mistake there is invisible in local dev (the frame-src gap shipped
// exactly this way). These pin the dev server's parity layer: the global
// block is applied to dev responses, with the ONE documented dev-only
// amendment (inline scripts for the React fast-refresh preamble).
describe('devHeadersFromCloudflareHeaders', () => {
  const dev = devHeadersFromCloudflareHeaders(headersText)

  it('applies the global security headers to dev responses verbatim', () => {
    expect(dev.get('X-Content-Type-Options')).toBe('nosniff')
    expect(dev.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  it('keeps the production CSP resource policy — the frame-src gap must reproduce in dev', () => {
    const csp = dev.get('Content-Security-Policy') ?? ''
    expect(csp).toContain('frame-src https:')
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("worker-src 'self'")
  })

  it("amends script-src with 'unsafe-inline' ONLY (the react-refresh preamble is inline in dev)", () => {
    const csp = dev.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'")
    // The amendment is surgical: nothing else gains unsafe-inline.
    expect(csp.match(/'unsafe-inline'/g)).toHaveLength(
      (readFileSync(resolve(__dirname, 'public/_headers'), 'utf8').match(/'unsafe-inline'/g)
        ?.length ?? 0) + 1,
    )
  })

  it('never applies path-scoped blocks (sw.js cache rules are not dev concerns)', () => {
    expect(dev.get('Cache-Control')).toBeUndefined()
  })
})
