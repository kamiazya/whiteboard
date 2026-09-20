import { parseBearerAuthorizationHeader } from './bearer-token.js'
import type { CredentialResolver } from './credential-resolver.js'
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
 * `/mcp` in local-daemon mode.
 *
 * The credential is resolved by `credential-resolver.ts` like every other
 * surface's; what is decided here is which GRANTS this surface admits, and
 * today that is only full authority.
 *
 * **That is a preserved absence, not a new restriction.** A pairing token, an
 * OAuth grant and a macaroon all reach `/api/*` and the websocket and none of
 * them has ever reached `/mcp` — each is where a diff stopped rather than a
 * decision anyone took. Admitting them is Task #34, and a narrow credential
 * would then have to carry `mcp:call`, which is the scope server-mode already
 * enforces on this route. Widening it here in passing would have made the
 * refactor a behaviour change disguised as one.
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
      })
      // `anonymous` is a daemon with no token configured, which this route has
      // always let through.
      if (grant?.kind === 'daemon-token' || grant?.kind === 'anonymous') {
        return { ok: true }
      }

      return {
        ok: false,
        status: 401,
        message: 'unauthorized',
        headers: createUnauthorizedHeaders(context.requestUrl, options.protectedResourceMetadata),
      }
    },
  }
}
