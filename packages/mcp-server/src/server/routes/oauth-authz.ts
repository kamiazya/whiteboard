// The hosted-origin OAuth 2.1 authorization-server surface (ADR-0005):
// metadata documents plus the authorization-code + PKCE token exchange.
// This router deliberately does not include /authorize — that is a later
// slice's approval-UI surface. Host-guard and CORS wiring for the routes
// this file registers happen in app.ts, mirroring how /api/* is wired
// (see api-host-guard.ts's header comment: middleware does not extend to
// a new mount point just by being registered "near" it).

import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { AUTH_SCOPES } from '../security/auth-strategy.js'
import {
  buildOAuthAuthorizationServerMetadata,
  buildOAuthProtectedResourceMetadata,
} from '../security/oauth-authz-metadata.js'
import {
  isRegisteredRedirectUri,
  type OAuthClientRegistry,
} from '../security/oauth-authz-registry.js'
import type { OAuthTransactionStore } from '../security/oauth-authz-transactions.js'

// RFC 9728's well-known suffix must not collide with the existing MCP
// resource metadata already served at the bare
// `/.well-known/oauth-protected-resource` path (mcp-auth.ts, describing
// the `/mcp` resource). RFC 9728 §3 supports per-resource metadata
// documents distinguished by a path suffix; this mirrors the codebase's
// existing `/mcp` suffix convention but for the `/api` resource instead.
const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/api'
const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server'
export const OAUTH_TOKEN_PATH = '/token'

// Exported so the caller can attach this router's middleware to exactly these
// paths. Hono's `app.route('/', subApp)` merges a sub-app's `use('*')` into the
// parent as `/*` — it does NOT confine it to the sub-app's own routes — so a
// sub-app is the wrong tool for scoping middleware.
export const OAUTH_AUTHZ_PATHS = [
  PROTECTED_RESOURCE_METADATA_PATH,
  AUTHORIZATION_SERVER_METADATA_PATH,
  OAUTH_TOKEN_PATH,
] as const

export const tokenRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().min(1),
  client_id: z.string().min(1),
  // Deliberately not `.optional()`: a request that omits code_verifier
  // entirely must fail Zod parsing before reaching the transaction store,
  // closing the trap at the boundary as well as inside the store.
  code_verifier: z.string().min(1),
})

export type TokenRequest = z.infer<typeof tokenRequestSchema>

export const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  scope: z.string(),
})

export type TokenResponse = z.infer<typeof tokenResponseSchema>

export const tokenErrorResponseSchema = z.object({
  error: z.enum(['invalid_request', 'invalid_grant']),
})

export type TokenErrorResponse = z.infer<typeof tokenErrorResponseSchema>

function tokenError(error: TokenErrorResponse['error']) {
  return { status: 400 as const, body: tokenErrorResponseSchema.parse({ error }) }
}

// RFC 6749 §5.1/§5.2: the token endpoint's responses carry credentials and
// MUST NOT be stored. `Pragma: no-cache` is omitted deliberately — it is an
// HTTP/1.0 request-header artifact that RFC 7234 §5.4 gives no defined
// meaning as a response header, and no HTTP/1.1 cache consults it.
const TOKEN_CACHE_CONTROL = { 'Cache-Control': 'no-store' } as const

// RFC 6749 §4.1.3 / OAuth 2.1 §4.1.3: the token request body is
// `application/x-www-form-urlencoded`; a spec-compliant client (including the
// MCP SDK's own OAuth client) sends nothing else. JSON is additionally
// accepted because this daemon's other POST surfaces are JSON and a
// hand-rolled local client reaching for `fetch(..., {json})` failing with an
// opaque `invalid_request` would be a needless trap — the parsed shape is
// validated by the same Zod schema either way, so accepting both widens the
// wire format, not the contract.
async function readTokenRequestBody(c: Context): Promise<unknown> {
  const contentType = c.req.header('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return await c.req.json()
  }
  const params = new URLSearchParams(await c.req.text())
  return Object.fromEntries(params.entries())
}

export interface OAuthAuthzRouterOptions {
  store: OAuthTransactionStore
  registry: OAuthClientRegistry
}

export function createOAuthAuthzRouter(options: OAuthAuthzRouterOptions) {
  const app = new Hono()

  app.get(PROTECTED_RESOURCE_METADATA_PATH, (c) => {
    return c.json(buildOAuthProtectedResourceMetadata(c.req.url))
  })

  app.get(AUTHORIZATION_SERVER_METADATA_PATH, (c) => {
    return c.json(buildOAuthAuthorizationServerMetadata(c.req.url, AUTH_SCOPES))
  })

  app.post(OAUTH_TOKEN_PATH, async (c) => {
    let rawBody: unknown
    try {
      rawBody = await readTokenRequestBody(c)
    } catch {
      const { status, body } = tokenError('invalid_request')
      return c.json(body, status, TOKEN_CACHE_CONTROL)
    }

    const parsedRequest = tokenRequestSchema.safeParse(rawBody)
    if (!parsedRequest.success) {
      const { status, body } = tokenError('invalid_request')
      return c.json(body, status, TOKEN_CACHE_CONTROL)
    }
    const { code, redirect_uri, client_id, code_verifier } = parsedRequest.data

    // Exact byte-for-byte registry check — never derived from an origin
    // allowlist. See oauth-authz-registry.ts.
    if (!isRegisteredRedirectUri(options.registry, client_id, redirect_uri)) {
      const { status, body } = tokenError('invalid_grant')
      return c.json(body, status, TOKEN_CACHE_CONTROL)
    }

    const result = options.store.redeemAuthorizationCode({
      code,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeVerifier: code_verifier,
    })
    if (!result.ok) {
      const { status, body } = tokenError(
        result.reason === 'invalid_request' ? 'invalid_request' : 'invalid_grant',
      )
      return c.json(body, status, TOKEN_CACHE_CONTROL)
    }

    const minted = options.store.mintAccessToken(result.scopes, result.clientId)
    const response: TokenResponse = tokenResponseSchema.parse({
      access_token: minted.accessToken,
      token_type: 'Bearer',
      expires_in: minted.expiresIn,
      scope: result.scopes.join(' '),
    })
    return c.json(response, 200, TOKEN_CACHE_CONTROL)
  })

  return app
}
