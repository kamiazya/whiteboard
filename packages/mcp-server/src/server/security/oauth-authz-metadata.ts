// RFC 9728 (protected resource) and RFC 8414 (authorization server)
// metadata documents for the hosted-origin OAuth 2.1 authorization server
// (ADR-0005). These describe the daemon's own `/api` resource and its own
// `/token` (and future `/authorize`) endpoints — distinct from the
// existing MCP-resource metadata in mcp-auth.ts, which describes the
// separate `/mcp` resource and is served at its own `/mcp`-suffixed
// well-known path for exactly that reason (see oauth-authz.ts for the
// mount path chosen to avoid colliding with it).

import { z } from 'zod'

const oauthProtectedResourceMetadataSchema = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()).min(1),
})

export type OAuthProtectedResourceMetadata = z.infer<typeof oauthProtectedResourceMetadataSchema>

const oauthAuthorizationServerMetadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  response_types_supported: z.array(z.literal('code')),
  grant_types_supported: z.array(z.literal('authorization_code')),
  code_challenge_methods_supported: z.array(z.literal('S256')),
  // 'none' per RFC 8414 §2 — the hosted client is a public SPA with no
  // mechanism to hold a client secret; PKCE is the client-authentication
  // substitute for a public client, not client_secret_basic/post.
  token_endpoint_auth_methods_supported: z.array(z.literal('none')),
  scopes_supported: z.array(z.string()),
})

export type OAuthAuthorizationServerMetadata = z.infer<
  typeof oauthAuthorizationServerMetadataSchema
>

export function buildOAuthProtectedResourceMetadata(
  requestUrl: string,
): OAuthProtectedResourceMetadata {
  return oauthProtectedResourceMetadataSchema.parse({
    resource: new URL('/api', requestUrl).toString(),
    authorization_servers: [new URL('/', requestUrl).toString()],
  })
}

export function buildOAuthAuthorizationServerMetadata(
  requestUrl: string,
  scopesSupported: readonly string[],
): OAuthAuthorizationServerMetadata {
  return oauthAuthorizationServerMetadataSchema.parse({
    issuer: new URL('/', requestUrl).toString(),
    authorization_endpoint: new URL('/authorize', requestUrl).toString(),
    token_endpoint: new URL('/token', requestUrl).toString(),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...scopesSupported],
  })
}
