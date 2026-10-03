import { hasRequiredScopes } from './auth-strategy.js'
import { parseBearerAuthorizationHeader } from './bearer-token.js'
import type { CredentialResolver, ResolvedGrant } from './credential-resolver.js'

interface McpAuthRequestContext {
  method: string
  authorizationHeader?: string
}

type McpAuthDecision =
  | { ok: true }
  | {
      ok: false
      status: 401 | 403
      message: string
      headers: Headers
    }

export interface McpHttpAuthStrategy {
  authorize(context: McpAuthRequestContext): Promise<McpAuthDecision>
}

/** A CORS preflight carries no credentials, so it is the one method the strategy never asks for them. */
export function requiresMcpHttpAuth(method: string): boolean {
  return method.toUpperCase() !== 'OPTIONS'
}

/**
 * Whether a resolved grant may speak MCP on this daemon.
 *
 * An exhaustive switch rather than a predicate, so a seventh credential kind
 * cannot arrive and inherit whichever answer the last `else` happened to
 * give — the absences this replaced were exactly that.
 */
function admitsMcp(grant: ResolvedGrant): boolean {
  switch (grant.kind) {
    // Full authority. `anonymous` is a daemon with no token configured, which
    // this route has always let through.
    case 'daemon-token':
    case 'anonymous':
      return true
    case 'macaroon':
      return hasRequiredScopes(grant.scopes, ['mcp:call'])
    // Server mode's kinds: this resolver never produces them, and server
    // mode's `/mcp` is authorized by its own middleware.
    case 'signed-in':
    case 'external-bearer':
      return false
  }
}

/**
 * `/mcp` in local-daemon mode.
 *
 * The credential is resolved by `credential-resolver.ts` like every other
 * surface's; what is decided here is which GRANTS this surface admits.
 *
 * **Full authority passes; a narrow credential passes iff it carries
 * `mcp:call`** — the same scope server-mode already enforces on this route
 * (`createServerModeMcpAuthMiddleware` asks the bearer for it),
 * so the two modes agree rather than each having their own rule.
 *
 * A verified credential that this surface will not admit gets **403 without a
 * challenge**, per the 401/403 contract in `auth-strategy.ts`: re-presenting
 * the same credential cannot help, so there is no scheme to advertise.
 */
export function createLocalTokenMcpHttpAuthStrategy(options: {
  resolver: CredentialResolver
}): McpHttpAuthStrategy {
  return {
    async authorize(context) {
      if (!requiresMcpHttpAuth(context.method)) {
        return { ok: true }
      }

      const grant = await options.resolver.resolve({
        secret: parseBearerAuthorizationHeader(context.authorizationHeader),
      })

      if (grant === null) {
        return {
          ok: false,
          status: 401,
          message: 'unauthorized',
          headers: new Headers(),
        }
      }

      const admitted = admitsMcp(grant)
      if (admitted) return { ok: true }

      // No `WWW-Authenticate`: the credential verified, so a retry with it
      // changes nothing.
      return { ok: false, status: 403, message: 'forbidden', headers: new Headers() }
    },
  }
}
