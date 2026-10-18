import type { MiddlewareHandler } from 'hono'
import type { McpHttpAuthStrategy } from './mcp-auth.js'
import { runWithMcpScopes } from './mcp-caller.js'

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

export function createMcpHttpAuthMiddleware(strategy: McpHttpAuthStrategy): MiddlewareHandler {
  return async (c, next) => {
    const decision = await strategy.authorize({
      method: c.req.method,
      authorizationHeader: c.req.header('authorization'),
    })
    if (!decision.ok) {
      return mcpHttpError(decision.status, decision.message, decision.headers)
    }
    if (decision.scopes !== undefined) return runWithMcpScopes(decision.scopes, next)
    return next()
  }
}
