import type { MiddlewareHandler } from 'hono'

import type { McpHttpAuthStrategy } from './mcp-auth.js'
import {
  appendVary,
  getRequestHost,
  isLoopbackHostname,
  normalizeHostHeader,
  normalizeOriginHostname,
} from './cors-loopback.js'
import { isAllowedWebOrigin } from './web-origin-allowlist.js'

function normalizeMethod(method: string): string {
  return method.toUpperCase()
}

function mcpHttpError(status: number, message: string, headers?: Headers): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    },
    { status, headers },
  )
}

export function isAllowedMcpHttpOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  allowedOrigins: readonly string[] = [],
): boolean {
  // DNS-rebinding guard: unchanged regardless of the Origin allowlist below —
  // the request Host must always be loopback.
  const requestHost = normalizeHostHeader(hostHeader)
  if (!requestHost || !isLoopbackHostname(requestHost)) {
    return false
  }
  if (!originHeader) return true
  const originHost = normalizeOriginHostname(originHeader)
  if (originHost !== null && isLoopbackHostname(originHost)) return true
  return isAllowedWebOrigin(originHeader, allowedOrigins)
}

export function requiresMcpHttpAuth(method: string): boolean {
  return normalizeMethod(method) !== 'OPTIONS'
}

export function createMcpHttpOriginMiddleware(
  allowedOrigins: readonly string[] = [],
): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const host = getRequestHost(c)
    if (!isAllowedMcpHttpOrigin(origin, host, allowedOrigins)) {
      return mcpHttpError(403, 'forbidden origin')
    }

    if (origin) {
      c.res.headers.set('Access-Control-Allow-Origin', origin)
      c.res.headers.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
      )
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      c.res.headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id')
      c.res.headers.set('Access-Control-Max-Age', '86400')
      c.res.headers.set('Vary', appendVary(c.res.headers.get('Vary'), 'Origin'))
    }

    if (normalizeMethod(c.req.method) === 'OPTIONS') {
      if (origin) {
        // Local Network Access preflight headers — required by Chrome for
        // private-network → loopback requests. Both the legacy PNA header and
        // its in-flight successor (ALN) are emitted so the preflight
        // satisfies whichever LNA generation the browser enforces.
        // https://wicg.github.io/local-network-access/
        c.res.headers.set('Access-Control-Allow-Private-Network', 'true')
        c.res.headers.set('Access-Control-Allow-Local-Network', 'true')
      }
      return new Response(null, { status: 204, headers: c.res.headers })
    }

    await next()

    if (origin) {
      c.res.headers.set('Access-Control-Allow-Origin', origin)
      c.res.headers.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
      )
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      c.res.headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id')
      c.res.headers.set('Access-Control-Max-Age', '86400')
      c.res.headers.set('Vary', appendVary(c.res.headers.get('Vary'), 'Origin'))
    }
  }
}

export function createMcpHttpAuthMiddleware(strategy: McpHttpAuthStrategy): MiddlewareHandler {
  return async (c, next) => {
    const decision = strategy.authorize({
      method: c.req.method,
      authorizationHeader: c.req.header('authorization'),
      requestUrl: c.req.url,
    })
    if (!decision.ok) {
      return mcpHttpError(decision.status, decision.message, decision.headers)
    }
    return next()
  }
}
