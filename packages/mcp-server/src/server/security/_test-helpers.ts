// A Hono middleware over an `AsyncAuthStrategy`, for the tests that drive a
// strategy end to end through a real app. Test support only: the production
// `/api` middleware is `createServerModeApiAuthMiddleware`, which also gates
// membership — a second middleware that skips that gate must not be
// importable from production code, which is why this lives beside the tests.
import type { MiddlewareHandler } from 'hono'
import type { AuthScope } from './auth-strategy.js'
import type { AsyncAuthStrategy } from './oauth-resource-strategy.js'
import type { ResolvedProvider } from './oidc-relying-party.js'
import type { OidcProvider, SignInProvider } from './sign-in-config.js'

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

/**
 * The OIDC providers of a parsed sign-in config. The config's provider list is
 * a union with the reverse-proxy kind; a test that builds only OIDC providers
 * narrows it here and fails by name if that stops being true.
 */
export function oidcProviders(providers: readonly SignInProvider[]): OidcProvider[] {
  return providers.map((provider) => {
    if (provider.kind !== 'oidc') throw new Error(`expected an oidc provider, got ${provider.kind}`)
    return provider
  })
}

/** An OIDC provider as the sign-in routes hold it once its secret is resolved at startup. */
export function resolvedForTest(provider: OidcProvider): ResolvedProvider {
  if (provider.clientId === undefined)
    throw new Error(`provider ${provider.id} declares no clientId`)
  return { ...provider, clientId: provider.clientId, clientSecretValue: 's3cret' }
}

/** A strategy that refuses every request, for tests that never reach an authenticated route. */
export const DENY_ALL_STRATEGY: AsyncAuthStrategy = {
  authorize: async () => ({
    ok: false,
    status: 401,
    code: 'auth.required',
    wwwAuthenticate: 'Bearer',
  }),
}
