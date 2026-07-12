import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'

// Timing-safe string comparison. Even length mismatches avoid early return by doing
// a dummy comparison so timing stays uniform.
// The practical risk is low for loopback-only use, but this is still useful
// defense in depth for remote or multi-tenant deployments.
function safeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) {
    // Do a same-length dummy comparison to keep timing uniform.
    timingSafeEqual(aBuf, aBuf)
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}

// Returns the raw Bearer token from a well-formed `Authorization: Bearer <token>`
// header, or null for any malformed / missing input. Strict: requires exactly one
// space after "Bearer", a non-empty token, and no whitespace, commas, or quotes
// in the token (those shapes indicate multi-value or non-token inputs).
export function parseBearerAuthorizationHeader(header: string | undefined): string | null {
  if (typeof header !== 'string') return null
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length)
  if (token.length === 0 || /[\s,"]/.test(token)) return null
  return token
}

export function isAuthorized(
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  if (!token) return true
  const parsed = parseBearerAuthorizationHeader(authorization)
  return parsed !== null && safeStringEqual(parsed, token)
}

// Local-daemon mode requires the shared bearer token on every /api/* request,
// read or write. `/api/runtime/ping` is the sole exception — it is the
// availability probe apps/web calls before it knows whether a token is even
// available (see ADR-0002) — everything else under /api/runtime/* re-checks
// the bearer itself (runtime.ts), so double-gating it here is redundant but
// harmless, not a hole.
//
// Canvas/asset GET used to be carved out entirely (ADR-0002's original
// decision: loopback bind + Host-loopback check + hard-to-guess ids were
// judged sufficient, and tokenizing reads looked like it would break <img
// src> thumbnails for no real gain). That containment assumption breaks once
// a hosted origin is an admitted CORS caller (ADR-0005): an admitted origin,
// or anyone who gets past the allowlist, could then read every canvas with
// no credential at all. The client-side cost of closing this turned out to
// be zero — every read already goes through a bearer-carrying fetch
// (shared/api-client.ts's apiFetch, and every thumbnail/file consumer
// fetches bytes and renders an object URL instead of a bare <img src>) — so
// there is no reason left to leave the server side open.
export function requiresDaemonAuth(path: string): boolean {
  if (!path.startsWith('/api/')) return false
  if (path === '/api/runtime/ping') return false
  return true
}

export function createDaemonAuthMiddleware(token?: string): MiddlewareHandler {
  return async (c, next) => {
    if (!requiresDaemonAuth(c.req.path)) {
      return next()
    }
    if (!isAuthorized(c.req.header('authorization'), token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  }
}
