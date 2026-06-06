import type { MiddlewareHandler } from 'hono'

import type { McpHttpAuthStrategy } from './mcp-auth.js'
import { appendVary, isLoopbackHostname, normalizeOriginHostname } from './cors-loopback.js'

function normalizeMethod(method: string): string {
  return method.toUpperCase()
}

function normalizeHostname(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return null
  }
}

function getRequestHost(c: Parameters<MiddlewareHandler>[0]): string | undefined {
  const headerHost = c.req.header('host')
  if (headerHost) return headerHost
  try {
    return new URL(c.req.url).host
  } catch {
    return undefined
  }
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
): boolean {
  const requestHost = normalizeHostname(hostHeader)
  if (!requestHost || !isLoopbackHostname(requestHost)) {
    return false
  }
  if (!originHeader) return true
  const originHost = normalizeOriginHostname(originHeader)
  return originHost !== null && isLoopbackHostname(originHost)
}

export function requiresMcpHttpAuth(method: string): boolean {
  return normalizeMethod(method) !== 'OPTIONS'
}

export function createMcpHttpOriginMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const host = getRequestHost(c)
    if (!isAllowedMcpHttpOrigin(origin, host)) {
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
        // Local Network Access preflight header — required by Chrome for
        // private-network → loopback requests regardless of PNA spec state.
        c.res.headers.set('Access-Control-Allow-Private-Network', 'true')
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
