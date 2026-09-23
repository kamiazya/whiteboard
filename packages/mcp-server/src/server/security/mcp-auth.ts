import { hasRequiredScopes } from './auth-strategy.js'
import { parseBearerAuthorizationHeader } from './bearer-token.js'
import type { CredentialResolver, ResolvedGrant } from './credential-resolver.js'
import { requiresMcpHttpAuth } from './mcp-http.js'

export interface McpProtectedResourceMetadataConfig {
  authorizationServers: string[]
  resource?: string
  scopesSupported?: string[]
}

interface McpAuthRequestContext {
  method: string
  authorizationHeader?: string
  requestUrl: string
  /**
   * The browser-enforced `Origin`, when the request carried one. A pairing
   * token is bound to an origin, so without this the resolver cannot identify
   * one — and an unidentified pairing token refuses as `null`, which is a 401
   * inviting a retry rather than the 403 this surface means.
   */
  origin?: string
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
  readonly protectedResourceMetadata?: McpProtectedResourceMetadataConfig
  authorize(context: McpAuthRequestContext): Promise<McpAuthDecision>
}

function normalizeCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : undefined
}

export function resolveMcpProtectedResourceMetadataFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): McpProtectedResourceMetadataConfig | undefined {
  const authorizationServers =
    normalizeCsv(env.WHITEBOARD_MCP_AUTHORIZATION_SERVERS) ??
    normalizeCsv(env.WHITEBOARD_MCP_AUTHORIZATION_SERVER)

  if (!authorizationServers) {
    return undefined
  }

  return {
    authorizationServers,
    resource: env.WHITEBOARD_MCP_RESOURCE?.trim() || undefined,
    scopesSupported: normalizeCsv(env.WHITEBOARD_MCP_SCOPES_SUPPORTED),
  }
}

function getMcpProtectedResourceMetadataUrl(requestUrl: string): string {
  return new URL('/.well-known/oauth-protected-resource/mcp', requestUrl).toString()
}

function buildWwwAuthenticateHeader(
  requestUrl: string,
  metadata: McpProtectedResourceMetadataConfig | undefined,
  options?: {
    error?: string
    scope?: string[]
    errorDescription?: string
  },
): string | null {
  const parts = ['Bearer']

  if (options?.error) {
    parts.push(`error="${options.error}"`)
  }
  if (options?.scope && options.scope.length > 0) {
    parts.push(`scope="${options.scope.join(' ')}"`)
  }
  if (metadata) {
    parts.push(`resource_metadata="${getMcpProtectedResourceMetadataUrl(requestUrl)}"`)
  }
  if (options?.errorDescription) {
    parts.push(`error_description="${options.errorDescription}"`)
  }

  return parts.length > 1 ? parts.join(' ') : null
}

function createUnauthorizedHeaders(
  requestUrl: string,
  metadata: McpProtectedResourceMetadataConfig | undefined,
): Headers {
  const headers = new Headers()
  const challenge = buildWwwAuthenticateHeader(requestUrl, metadata)
  if (challenge) {
    headers.set('WWW-Authenticate', challenge)
  }
  return headers
}

export function buildMcpProtectedResourceMetadata(
  strategy: McpHttpAuthStrategy,
  requestUrl: string,
): {
  resource: string
  authorization_servers: string[]
  scopes_supported?: string[]
} | null {
  const metadata = strategy.protectedResourceMetadata
  if (!metadata) {
    return null
  }

  return {
    resource: metadata.resource ?? new URL('/mcp', requestUrl).toString(),
    authorization_servers: metadata.authorizationServers,
    ...(metadata.scopesSupported ? { scopes_supported: metadata.scopesSupported } : {}),
  }
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
    case 'oauth-grant':
    case 'macaroon':
      return hasRequiredScopes(grant.scopes, ['mcp:call'])
    // A paired browser origin talks to `/api/*`; the web app speaks no MCP.
    case 'pairing':
      return false
    // Unreachable on this surface — a ticket only resolves under the
    // `ws-ticket` carrier — and answered rather than left to a default so the
    // switch stays exhaustive if that ever changes.
    case 'ws-ticket':
      return false
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
 * (`app.ts` mounts `createServerModeAsyncAuthMiddleware(..., ['mcp:call'])`),
 * so the two modes now agree rather than each having their own rule. The
 * daemon's own OAuth consent screen already offers `mcp:call` and marks it a
 * write scope, so a user could approve it and then be refused by this surface
 * outright: the same shape `routes/runtime.ts` had, where the route-scope
 * registry declared an opening the surface did not honour. Failing closed, so
 * not a hole — a feature that did not work where the daemon said it did.
 *
 * **A pairing token is refused, and that is a decision rather than an
 * absence.** It holds every scope today, so no scope test can express this:
 * a paired browser origin reaches `/api/*`, and nothing in the web app speaks
 * MCP. Narrowing what a pairing token carries is its own increment.
 *
 * A verified credential that this surface will not admit gets **403 without a
 * challenge**, per the 401/403 contract in `auth-strategy.ts`: re-presenting
 * the same credential cannot help, so there is no scheme to advertise.
 */
export function createLocalTokenMcpHttpAuthStrategy(options: {
  resolver: CredentialResolver
  protectedResourceMetadata?: McpProtectedResourceMetadataConfig
}): McpHttpAuthStrategy {
  return {
    protectedResourceMetadata: options.protectedResourceMetadata,
    async authorize(context) {
      if (!requiresMcpHttpAuth(context.method)) {
        return { ok: true }
      }

      const grant = await options.resolver.resolve({
        secret: parseBearerAuthorizationHeader(context.authorizationHeader),
        carrier: 'bearer',
        origin: context.origin,
      })

      if (grant === null) {
        return {
          ok: false,
          status: 401,
          message: 'unauthorized',
          headers: createUnauthorizedHeaders(context.requestUrl, options.protectedResourceMetadata),
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
