// Shared loopback-CORS helpers used by both /mcp and /api/* middleware.
// Keeping these in one place prevents the two CORS paths from drifting
// when the loopback definition or Vary logic needs updating.

import type { Context, MiddlewareHandler } from 'hono'
import { isAllowedWebOrigin } from './web-origin-allowlist.js'

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

// URL.hostname returns bracketed IPv6 (e.g. "[::1]"); strip the brackets so
// isLoopbackHostname can match against the bare address "::1".
// See WHATWG URL spec §4.1 (host serializing).
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

export function normalizeOriginHostname(originHeader: string | undefined): string | null {
  if (!originHeader) return null
  try {
    return stripIpv6Brackets(new URL(originHeader).hostname)
  } catch {
    return null
  }
}

// Canonical Host-header normalizer shared by ws-auth, mcp-http, and the
// /api/* host guard so the loopback definition cannot drift between them.
// A Host header is host[:port] only — anything URL parsing shunts into
// credentials, path, query, or fragment (e.g. "evil.example@localhost",
// "localhost/x") is malformed and must be rejected rather than normalized
// down to a loopback hostname that would slip past the guard.
export function normalizeHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  try {
    const url = new URL(`http://${hostHeader}`)
    if (url.username !== '' || url.password !== '') return null
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
    return stripIpv6Brackets(url.hostname)
  } catch {
    return null
  }
}

// Resolve the request Host: prefer the Host header, fall back to the parsed
// request URL. Shared by the /mcp and /api/* host guards.
export function getRequestHost(c: Context): string | undefined {
  const headerHost = c.req.header('host')
  if (headerHost) return headerHost
  try {
    return new URL(c.req.url).host
  } catch {
    return undefined
  }
}

function setApiCorsHeaders(c: Context, origin: string): void {
  c.res.headers.set('Access-Control-Allow-Origin', origin)
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  c.res.headers.set('Access-Control-Max-Age', '86400')
  c.res.headers.set('Vary', appendVary(c.res.headers.get('Vary'), 'Origin'))
}

export function appendVary(value: string | null, token: string): string {
  if (!value || value.length === 0) return token
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const tokenLower = token.toLowerCase()
  return parts.some((p) => p.toLowerCase() === tokenLower)
    ? parts.join(', ')
    : [...parts, token].join(', ')
}

/**
 * Middleware for /api/* routes in local-daemon mode.
 *
 * OPTIONS requests always return 204 immediately regardless of origin — no
 * CORS headers are emitted for non-admitted origins, and the downstream auth
 * chain is never reached for OPTIONS.
 *
 * For admitted Origins (loopback — localhost, 127.0.0.1, ::1 — OR an exact
 * match in `allowedOrigins`, e.g. a hosted pairing origin) on non-OPTIONS
 * requests:
 *   - Reflects Access-Control-Allow-Origin and Vary: Origin.
 *   - Falls through to the downstream auth chain so mutation routes are never
 *     bypassed (Bearer is still required for mutations regardless of origin).
 *
 * For non-admitted Origins or no Origin header on non-OPTIONS requests: no
 * CORS headers emitted and the request is forwarded (same-origin and
 * daemon-served-page callers must not be broken by a 403).
 *
 * Never applied in server-mode (the caller guards this).
 */
export function createApiLoopbackCorsMiddleware(
  allowedOrigins: readonly string[] = [],
): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const originHost = normalizeOriginHostname(origin)
    const isLoopback = originHost !== null && isLoopbackHostname(originHost)
    const isAdmitted = isLoopback || isAllowedWebOrigin(origin, allowedOrigins)

    if (isAdmitted && origin) {
      setApiCorsHeaders(c, origin)
    }

    if (c.req.method.toUpperCase() === 'OPTIONS') {
      if (isAdmitted && origin) {
        // Access-Control-Allow-Local-Network is Chrome's in-flight successor
        // to Access-Control-Allow-Private-Network; both are emitted so the
        // preflight satisfies whichever LNA generation the browser enforces.
        // https://wicg.github.io/local-network-access/
        c.res.headers.set('Access-Control-Allow-Private-Network', 'true')
        c.res.headers.set('Access-Control-Allow-Local-Network', 'true')
      }
      return new Response(null, { status: 204, headers: c.res.headers })
    }

    await next()

    if (isAdmitted && origin) {
      setApiCorsHeaders(c, origin)
    }
  }
}
