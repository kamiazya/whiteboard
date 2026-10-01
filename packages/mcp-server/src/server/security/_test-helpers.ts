// A Hono middleware over an `AsyncAuthStrategy`, for the tests that drive a
// strategy end to end through a real app. Test support only: the production
// `/api` middleware is `createServerModeApiAuthMiddleware`, which also gates
// membership — a second middleware that skips that gate must not be
// importable from production code, which is why this lives beside the tests.
import type { MiddlewareHandler } from 'hono'
import type { AuthScope } from './auth-strategy.js'
import type { AsyncAuthStrategy } from './oauth-resource-strategy.js'

export function createAsyncAuthStrategyMiddleware(options: {
  strategy: AsyncAuthStrategy
  requiredScopes: readonly AuthScope[]
}): MiddlewareHandler {
  return async (c, next) => {
    const decision = await options.strategy.authorize({
      method: c.req.method,
      path: c.req.path,
      authorizationHeader: c.req.header('authorization'),
      requiredScopes: options.requiredScopes,
    })
    if (decision.ok) {
      return next()
    }
    const headers = new Headers({ 'content-type': 'application/json' })
    if (decision.status === 401) {
      headers.set('WWW-Authenticate', decision.wwwAuthenticate)
    }
    return new Response(JSON.stringify({ error: decision.code }), {
      status: decision.status,
      headers,
    })
  }
}
