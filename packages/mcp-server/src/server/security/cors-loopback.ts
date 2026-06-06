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
    return new URL(originHeader).hostname
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
  return parts.includes(token) ? parts.join(', ') : [...parts, token].join(', ')
}

/**
 * Middleware for /api/* routes in local-daemon mode.
 *
 * For loopback Origins (localhost, 127.0.0.1, ::1):
 *   - Reflects Access-Control-Allow-Origin and Vary: Origin on all responses.
 *   - On OPTIONS: adds Access-Control-Allow-Private-Network: true and returns
 *     204 immediately (the only early return — non-OPTIONS falls through to the
 *     downstream auth chain so mutation routes are never bypassed).
 *
 * For non-loopback Origins or no Origin header: no CORS headers emitted and
 * the request is still forwarded (same-origin and daemon-served-page callers
 * must not be broken by a 403).
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
      c.res.headers.set(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      )
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
      c.res.headers.set(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      )
      c.res.headers.set('Access-Control-Max-Age', '86400')
      c.res.headers.set('Vary', appendVary(c.res.headers.get('Vary'), 'Origin'))
    }
  }
}
