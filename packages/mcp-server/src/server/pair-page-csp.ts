import { randomBytes } from 'node:crypto'

/**
 * The Content-Security-Policy for `/pair`, the pairing consent page.
 *
 * `setBaselineSecurityHeaders` deliberately applies only
 * `frame-ancestors 'none'` when a route chose no policy of its own — a floor
 * that fits an API JSON response but leaves a real HTML page without
 * `script-src`, `object-src`, or `base-uri`. `/pair` is the one real page
 * this daemon serves and is the trust anchor a user consents on, so it
 * declares a full page policy here and the baseline leaves it alone.
 *
 * This mirrors the Cloudflare Pages policy in `apps/web/public/_headers`
 * (the same app shell is served from both origins) with two deliberate
 * differences:
 *
 * - `script-src` carries a per-response nonce. `/pair` is served by
 *   injecting two inline `<script>` tags into the built shell (runtime
 *   config and the daemon token), which `'self'` alone would block. A nonce
 *   authorizes exactly those two tags rather than opening the page to every
 *   inline script the way `'unsafe-inline'` would.
 * - `frame-src 'none'`. The hosted app allows `https:` frames for link-node
 *   embeds; the pairing page embeds nothing, and a consent page that can
 *   frame arbitrary remote content is needless attack surface.
 */
export function createCspNonce(): string {
  return randomBytes(16).toString('base64')
}

export function pairPageCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    // Thumbnails that need an Authorization header cannot be loaded by
    // pointing `<img src>` at the daemon, so they are fetched and rendered
    // through `URL.createObjectURL` — every one of them is a blob: URL.
    "img-src 'self' data: blob:",
    // The browser may hold either loopback spelling of this daemon's origin,
    // and 'self' only covers the one it was served from.
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
    "worker-src 'self'",
    "frame-src 'none'",
  ].join('; ')
}
