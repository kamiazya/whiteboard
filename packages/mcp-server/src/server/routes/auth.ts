import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'

function normalizeMethod(method: string): string {
  return method.toUpperCase()
}

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

function isMutationMethod(method: string): boolean {
  const normalized = normalizeMethod(method)
  return normalized === 'POST' || normalized === 'PUT' || normalized === 'DELETE' || normalized === 'PATCH'
}

export function requiresDaemonMutationAuth(method: string, path: string): boolean {
  if (!isMutationMethod(method)) return false
  if (!path.startsWith('/api/')) return false
  if (path.startsWith('/api/runtime/')) return false
  return true
}

export function createDaemonMutationAuthMiddleware(token?: string): MiddlewareHandler {
  return async (c, next) => {
    if (!requiresDaemonMutationAuth(c.req.method, c.req.path)) {
      return next()
    }
    if (!isAuthorized(c.req.header('authorization'), token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  }
}
