import { hasRequiredScopes } from './auth-strategy.js'
import { parseBearerAuthorizationHeader } from './bearer-token.js'
import type { CredentialResolver, ResolvedGrant } from './credential-resolver.js'

export interface McpProtectedResourceMetadataConfig {
  authorizationServers: string[]
  resource?: string
  scopesSupported?: string[]
}

interface McpAuthRequestContext {
  method: string
  authorizationHeader?: string
  requestUrl: string
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

/** A CORS preflight carries no credentials, so it is the one method the strategy never asks for them. */
export function requiresMcpHttpAuth(method: string): boolean {
  return method.toUpperCase() !== 'OPTIONS'
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
 * (`app.ts` mounts `createServerModeAsyncAuthMiddleware(..., ['mcp:call'])`),
 * so the two modes agree rather than each having their own rule.
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
