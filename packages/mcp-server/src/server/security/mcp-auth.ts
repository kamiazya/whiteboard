import { isAuthorized } from '../routes/auth.js'
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
  authorize(context: McpAuthRequestContext): McpAuthDecision
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

function _createNoAuthMcpHttpAuthStrategy(
  metadata?: McpProtectedResourceMetadataConfig,
): McpHttpAuthStrategy {
  return {
    protectedResourceMetadata: metadata,
    authorize() {
      return { ok: true }
    },
  }
}

export function createLocalTokenMcpHttpAuthStrategy(options: {
  token?: string
  protectedResourceMetadata?: McpProtectedResourceMetadataConfig
}): McpHttpAuthStrategy {
  return {
    protectedResourceMetadata: options.protectedResourceMetadata,
    authorize(context) {
      if (!options.token || !requiresMcpHttpAuth(context.method)) {
        return { ok: true }
      }

      if (isAuthorized(context.authorizationHeader, options.token)) {
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
