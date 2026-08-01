import type { MiddlewareHandler } from 'hono'
import type { RuntimeStatusResponse } from '../../shared/api-contracts/runtime.js'
import type { AuthScope } from './auth-strategy.js'
import type { AsyncAuthStrategy } from './oauth-resource-strategy.js'
import { matchOrigin, parseOriginPatterns } from './origin-pattern.js'
import { resolveApiRouteScope } from './route-scope-registry.js'

function buildServerModeAuthFailResponse(decision: {
  status: 401 | 403
  code: string
  wwwAuthenticate?: string
}): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (decision.status === 401 && decision.wwwAuthenticate) {
    headers.set('WWW-Authenticate', decision.wwwAuthenticate)
  }
  return new Response(JSON.stringify({ error: decision.code }), {
    status: decision.status,
    headers,
  })
}

export function createServerModeApiAuthMiddleware(
  authStrategy: AsyncAuthStrategy,
): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase()
    const routeScope = resolveApiRouteScope(method, c.req.path)
    // No declared decision at all: fail closed rather than silently applying
    // a guessed scope. Reaching this branch means a route was mounted under
    // /api/* without an entry in route-scope-registry.ts — the registry-wide
    // test (route-scope-registry.test.ts) is meant to catch this before it
    // ships, so a live 500 here means that guard was bypassed or the route
    // was added after the registry without updating both.
    if (routeScope === null) {
      return c.json({ error: 'auth.route-undeclared' }, 500)
    }
    // The `public` decision is a deliberate, documented carve-out (currently
    // only GET /api/runtime/ping — a liveness probe) — never an omission.
    if (routeScope.kind === 'public') return next()
    // `daemon-token-only` routes (e.g. /api/reconnect-credential) exist only
    // in local-daemon mode, which has no AsyncAuthStrategy — server-mode has
    // no daemon token to compare against, so any request that resolves here
    // is refused outright rather than guessed at.
    if (routeScope.kind === 'daemon-token-only') {
      return c.json({ error: 'forbidden' }, 403)
    }
    const decision = await authStrategy.authorize({
      method,
      path: c.req.path,
      authorizationHeader: c.req.header('authorization'),
      requiredScopes: routeScope.scopes,
    })
    if (decision.ok) return next()
    return buildServerModeAuthFailResponse(decision)
  }
}

export function createServerModeAsyncAuthMiddleware(
  authStrategy: AsyncAuthStrategy,
  requiredScopes: readonly AuthScope[],
): MiddlewareHandler {
  return async (c, next) => {
    const decision = await authStrategy.authorize({
      method: c.req.method,
      path: c.req.path,
      authorizationHeader: c.req.header('authorization'),
      requiredScopes,
    })
    if (decision.ok) return next()
    return buildServerModeAuthFailResponse(decision)
  }
}

// Pattern-aware: allowedOrigins may contain exact origins or leftmost-label
// wildcard subdomain patterns (see origin-pattern.ts). Deliberately does NOT
// build a Set of `new URL(o).origin` strings for exact-match lookup — that
// call does not throw on a wildcard entry (it parses '*' as a literal
// hostname character), so an exact-Set lookup would silently never admit a
// real subdomain rather than fail loudly.
export function createServerModeOriginMiddleware(
  allowedOrigins: readonly string[],
): MiddlewareHandler {
  const patterns = parseOriginPatterns(allowedOrigins)
  return async (c, next) => {
    const origin = c.req.header('origin')
    if (!origin) {
      if (c.req.method.toUpperCase() === 'OPTIONS') return new Response(null, { status: 204 })
      return next()
    }
    if (!matchOrigin(patterns, origin)) {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'forbidden origin' }, id: null },
        { status: 403 },
      )
    }
    c.res.headers.set('Access-Control-Allow-Origin', origin)
    c.res.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    )
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    c.res.headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id')
    c.res.headers.set('Access-Control-Max-Age', '86400')
    if (c.req.method.toUpperCase() === 'OPTIONS') {
      return new Response(null, { status: 204, headers: c.res.headers })
    }
    await next()
    c.res.headers.set('Access-Control-Allow-Origin', origin)
    c.res.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    )
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    c.res.headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id')
    c.res.headers.set('Access-Control-Max-Age', '86400')
  }
}

export function sanitizeServerModeStatus(
  getStatus: () => RuntimeStatusResponse,
  publicBaseUrl: string,
): () => RuntimeStatusResponse {
  const parsedUrl = new URL(publicBaseUrl)
  const derivedPort = parsedUrl.port
    ? parseInt(parsedUrl.port, 10)
    : parsedUrl.protocol === 'https:'
      ? 443
      : 80
  return () => {
    const raw = getStatus()
    return {
      ...raw,
      host: '[server-managed]',
      port: derivedPort,
      baseUrl: publicBaseUrl,
      storage: { ...raw.storage, dataDir: '[server-managed]' },
      mcp: { ...raw.mcp, endpoint: `${publicBaseUrl}/mcp` },
    }
  }
}
