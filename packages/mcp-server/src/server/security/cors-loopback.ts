// Shared loopback-CORS helpers used by both /mcp and /api/* middleware.
// Keeping these in one place prevents the two CORS paths from drifting
// when the loopback definition or Vary logic needs updating.

import type { MiddlewareHandler } from 'hono'

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function normalizeOriginHostname(originHeader: string | undefined): string | null {
  if (!originHeader) return null
  try {
    const hostname = new URL(originHeader).hostname
    // URL.hostname returns bracketed IPv6 (e.g. "[::1]"); strip the brackets
    // so isLoopbackHostname can match against the bare address "::1".
    // See WHATWG URL spec §4.1 (host serializing).
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname.slice(1, -1)
    }
    return hostname
  } catch {
    return null
  }
}

// Canonical Host-header normalizer shared by ws-auth, mcp-http, and the
// /api/* host guard so the loopback definition cannot drift between them.
export function normalizeHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname
    // URL.hostname returns bracketed IPv6 (e.g. "[::1]"); strip the brackets
    // so isLoopbackHostname can match against the bare address "::1".
    // See WHATWG URL spec §4.1 (host serializing).
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname.slice(1, -1)
    }
    return hostname
  } catch {
    return null
  }
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
 * CORS headers are emitted for non-loopback origins, and the downstream auth
 * chain is never reached for OPTIONS.
 *
 * For loopback Origins (localhost, 127.0.0.1, ::1) on non-OPTIONS requests:
 *   - Reflects Access-Control-Allow-Origin and Vary: Origin.
 *   - Falls through to the downstream auth chain so mutation routes are never
 *     bypassed.
 *
 * For non-loopback Origins or no Origin header on non-OPTIONS requests: no
 * CORS headers emitted and the request is forwarded (same-origin and
 * daemon-served-page callers must not be broken by a 403).
 *
 * Never applied in server-mode (the caller guards this).
 */
export function createApiLoopbackCorsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const originHost = normalizeOriginHostname(origin)
    const isLoopback = originHost !== null && isLoopbackHostname(originHost)

    if (isLoopback && origin) {
      c.res.headers.set('Access-Control-Allow-Origin', origin)
      c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      c.res.headers.set('Access-Control-Max-Age', '86400')
      c.res.headers.set('Vary', appendVary(c.res.headers.get('Vary'), 'Origin'))
    }

    if (c.req.method.toUpperCase() === 'OPTIONS') {
      if (isLoopback && origin) {
        c.res.headers.set('Access-Control-Allow-Private-Network', 'true')
      }
      return new Response(null, { status: 204, headers: c.res.headers })
    }

    await next()

    if (isLoopback && origin) {
      c.res.headers.set('Access-Control-Allow-Origin', origin)
      c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      c.res.headers.set('Access-Control-Max-Age', '86400')
      c.res.headers.set('Vary', appendVary(c.res.headers.get('Vary'), 'Origin'))
    }
  }
}
