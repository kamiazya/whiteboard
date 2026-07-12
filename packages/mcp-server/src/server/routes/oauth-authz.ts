// The hosted-origin OAuth 2.1 authorization-server surface (ADR-0005):
// metadata documents, the /authorize approval flow, and the
// authorization-code + PKCE token exchange. Host-guard and CORS wiring for
// the routes this file registers happen in app.ts, mirroring how /api/* is
// wired (see api-host-guard.ts's header comment: middleware does not extend
// to a new mount point just by being registered "near" it).

import { randomBytes } from 'node:crypto'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { AUTH_SCOPES, type AuthScope } from '../security/auth-strategy.js'
import {
  buildOAuthAuthorizationServerMetadata,
  buildOAuthProtectedResourceMetadata,
} from '../security/oauth-authz-metadata.js'
import {
  isRegisteredRedirectUri,
  type OAuthClientRegistry,
} from '../security/oauth-authz-registry.js'
import type { OAuthTransactionStore } from '../security/oauth-authz-transactions.js'
import {
  type AuthorizeErrorReason,
  renderApprovalPage,
  renderAuthorizeErrorPage,
} from './oauth-approval-page.js'

// RFC 9728's well-known suffix must not collide with the existing MCP
// resource metadata already served at the bare
// `/.well-known/oauth-protected-resource` path (mcp-auth.ts, describing
// the `/mcp` resource). RFC 9728 §3 supports per-resource metadata
// documents distinguished by a path suffix; this mirrors the codebase's
// existing `/mcp` suffix convention but for the `/api` resource instead.
const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/api'
const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server'
export const OAUTH_TOKEN_PATH = '/token'
export const OAUTH_AUTHORIZE_PATH = '/authorize'
export const OAUTH_AUTHORIZE_DECISION_PATH = '/authorize/decision'

// Exported so the caller can attach this router's middleware to exactly these
// paths. Hono's `app.route('/', subApp)` merges a sub-app's `use('*')` into the
// parent as `/*` — it does NOT confine it to the sub-app's own routes — so a
// sub-app is the wrong tool for scoping middleware.
export const OAUTH_AUTHZ_PATHS = [
  PROTECTED_RESOURCE_METADATA_PATH,
  AUTHORIZATION_SERVER_METADATA_PATH,
  OAUTH_TOKEN_PATH,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_AUTHORIZE_DECISION_PATH,
] as const

// The strict subset of the surface that a browser page on an allowed web
// origin is *supposed* to reach with a scripted, credentialed request: the
// two public metadata documents and the token exchange. The /authorize pair
// is deliberately absent. Those are top-level navigation targets; answering
// them with a reflected `Access-Control-Allow-Origin` would let the very
// hosted page that is asking for authorization read the approval screen and
// script the approval POST from its own context — handing itself the consent
// that the SameSite=Strict cookie and the double-submit CSRF binding exist to
// require a human to give. Absence of CORS headers is what makes the browser
// refuse to hand that response body to the requesting script.
export const OAUTH_AUTHZ_CORS_PATHS = [
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

// Both OAuth POST bodies are read in full before anything can reject them, and
// both are reachable with no credential at all — so an unbounded body is a
// straight OOM lever on a daemon holding the user's data. Every legitimate
// request here is a handful of short fields (a code, a verifier, a URI), so
// the cap can sit far below any real payload.
const OAUTH_BODY_LIMIT_BYTES = 8 * 1024
const oauthBodyLimit = bodyLimit({
  maxSize: OAUTH_BODY_LIMIT_BYTES,
  onError: (c) => c.text('Payload too large', 413),
})

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

// The /authorize query string, declared once. Note what is NOT here:
// client_id and redirect_uri are read and checked against the registry
// *before* this schema runs, because a failure of any rule below is
// reported by redirecting to the redirect_uri (RFC 6749 §4.1.2.1) — which
// is only a safe thing to do once that redirect_uri is known to be
// registered. Validating them together would mean a request with a bogus
// redirect_uri and a bogus scope could take the redirecting branch.
const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  state: z.string().min(1),
  // RFC 7636: PKCE is mandatory in OAuth 2.1. `S256` only — `plain` offers
  // no protection against an attacker who can observe the authorization
  // request, and permitting it as a fallback is the same as not requiring
  // PKCE at all.
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal('S256'),
  // Space-delimited per RFC 6749 §3.3, and REQUIRED here even though the RFC
  // permits omission: this server has no default scope, so "no scope" can
  // only mean an under-specified request, never a full grant.
  scope: z.string().min(1),
})

const authorizeScopesSchema = z.array(z.enum(AUTH_SCOPES)).min(1)

// RFC 6749 §4.1.2.1 error codes this endpoint can deliver to a *validated*
// redirect_uri. Codes about the client's or redirect_uri's own validity are
// absent by construction — those never redirect.
type AuthorizeRedirectError = 'invalid_request' | 'unsupported_response_type' | 'invalid_scope'

// RFC 6749 §3.3: scope is a space-delimited list. Splitting on general
// whitespace (rather than a single space) tolerates a client that
// double-encodes or joins with a tab without widening what is *accepted* —
// every token is still checked against the vocabulary.
function parseScopes(rawScope: string): readonly AuthScope[] | null {
  const tokens = rawScope.split(/\s+/).filter((token) => token.length > 0)
  const parsed = authorizeScopesSchema.safeParse(tokens)
  return parsed.success ? parsed.data : null
}

// The /authorize URL carries `state` and `code_challenge`, and the approval
// page is a security decision surface:
// - `no-store` keeps the approval screen and the redirect response (which
//   carries the authorization code in its Location) out of shared caches.
// - `no-referrer` stops the query string — state, code_challenge — from
//   leaking to any origin the page might reach.
// - DENY + `frame-ancestors 'none'` stop a clickjacked approval: the user
//   must see this page to click Approve on it.
// - `default-src 'none'` matches a page that loads nothing at all and has no
//   inline script; `form-action` is deliberately omitted, since the approval
//   POST's response is a cross-origin redirect to the client's callback.
// The single inline <style> is admitted by a per-response nonce rather than
// `style-src 'unsafe-inline'`: the grant then covers exactly the stylesheet
// this response carries, and nothing an injection could add to it.
function authorizeSecurityHeaders(styleNonce: string) {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${styleNonce}'; frame-ancestors 'none'; base-uri 'none'`,
  }
}

// Scoped to /authorize so it is never attached to any other request. The
// value is the transaction's csrfToken; the approval form echoes the same
// value in a hidden field, and both must match what the store bound at
// creation (double submit). SameSite=Strict keeps it off any cross-site
// navigation, so a POST driven from another origin arrives with no cookie
// at all and fails the check even before the form field is inspected.
const APPROVAL_COOKIE_NAME = 'whiteboard_oauth_approval'
const APPROVAL_COOKIE_PATH = OAUTH_AUTHORIZE_PATH

function isSecureRequest(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:'
}

function newStyleNonce(): string {
  return randomBytes(16).toString('base64')
}

function htmlResponse(
  c: Context,
  render: (styleNonce: string) => string,
  status: 200 | 400 | 403 | 429,
) {
  const styleNonce = newStyleNonce()
  return c.html(render(styleNonce), status, authorizeSecurityHeaders(styleNonce))
}

function errorPage(c: Context, reason: AuthorizeErrorReason, status: 400 | 403 | 429) {
  return htmlResponse(c, (styleNonce) => renderAuthorizeErrorPage(reason, styleNonce), status)
}

// RFC 6749 §4.1.2 / §4.1.2.1: the authorization response — success or error —
// is delivered as query parameters appended to the (registered) redirect_uri,
// and `state` is echoed back verbatim so the client can match the response to
// its own request.
function redirectToClient(
  c: Context,
  redirectUri: string,
  params: Record<string, string>,
  status: 302 | 303,
) {
  const target = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value)
  }
  return c.redirect(target.toString(), status)
}

// A form POST from the approval page is same-origin. Both signals are checked
// because neither alone is universally present: `Sec-Fetch-Site` is absent on
// older browsers, and `Origin` is what remains. Absence of both is treated as
// same-site — the double-submit CSRF binding, not this check, is the load
// bearing defense; this is defense in depth over it.
function isCrossSiteRequest(c: Context): boolean {
  const fetchSite = c.req.header('sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return true
  const origin = c.req.header('origin')
  if (origin !== undefined && origin !== new URL(c.req.url).origin) return true
  return false
}

const decisionFormSchema = z.object({
  transaction_id: z.string().min(1),
  csrf_token: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
})

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

  app.get(OAUTH_AUTHORIZE_PATH, (c) => {
    const query = c.req.query()
    const clientId = query.client_id ?? ''
    const redirectUri = query.redirect_uri ?? ''

    // Registry check FIRST, and locally rendered on failure. An unregistered
    // client_id or a redirect_uri that is not a byte-for-byte match of a
    // registered one must never produce a Location header: sending an OAuth
    // error to an unverified redirect_uri *is* an open redirect, and the
    // error parameters would be attacker-chosen bait on top of it.
    const knownClient = options.registry.some((entry) => entry.clientId === clientId)
    if (!knownClient) return errorPage(c, 'unknown_client', 400)
    if (!isRegisteredRedirectUri(options.registry, clientId, redirectUri)) {
      return errorPage(c, 'redirect_uri_mismatch', 400)
    }

    // Past this line the redirect_uri is trusted, so RFC 6749 §4.1.2.1
    // error redirects are safe.
    const parsed = authorizeQuerySchema.safeParse(query)
    if (!parsed.success) {
      const failedKeys = new Set(parsed.error.issues.map((issue) => issue.path[0]))
      const error: AuthorizeRedirectError = failedKeys.has('response_type')
        ? 'unsupported_response_type'
        : failedKeys.has('scope')
          ? 'invalid_scope'
          : 'invalid_request'
      // `state` may itself be the missing parameter; echo it only when the
      // client actually sent one.
      const state = query.state
      return redirectToClient(c, redirectUri, state ? { error, state } : { error }, 302)
    }

    const scopes = parseScopes(parsed.data.scope)
    if (!scopes) {
      return redirectToClient(
        c,
        redirectUri,
        { error: 'invalid_scope', state: parsed.data.state },
        302,
      )
    }

    if (!options.store.recordAuthorizeAttempt(clientId)) {
      return errorPage(c, 'rate_limited', 429)
    }

    // Minted here, never accepted from the request and never placed in a URL:
    // a CSRF token that travels in the query string is readable from the
    // Referer, browser history, and any logging proxy, which would make the
    // double-submit check a formality.
    const csrfToken = randomBytes(32).toString('base64url')
    const { transactionId } = options.store.createTransaction({
      clientId,
      redirectUri,
      scopes: [...scopes],
      state: parsed.data.state,
      codeChallenge: parsed.data.code_challenge,
      codeChallengeMethod: parsed.data.code_challenge_method,
      csrfToken,
    })

    const view = options.store.getTransactionForApproval(transactionId)
    if (!view) return errorPage(c, 'transaction_not_found', 400)

    setCookie(c, APPROVAL_COOKIE_NAME, csrfToken, {
      httpOnly: true,
      sameSite: 'Strict',
      path: APPROVAL_COOKIE_PATH,
      // Only over TLS: a Secure cookie on a plain-http loopback daemon would
      // never be sent back, breaking the flow the operator is running.
      secure: isSecureRequest(c),
    })
    return htmlResponse(
      c,
      (styleNonce) => renderApprovalPage({ transactionId, csrfToken, view, styleNonce }),
      200,
    )
  })

  app.post(OAUTH_AUTHORIZE_DECISION_PATH, oauthBodyLimit, async (c) => {
    if (isCrossSiteRequest(c)) return errorPage(c, 'csrf_check_failed', 403)

    const form = decisionFormSchema.safeParse(
      Object.fromEntries(new URLSearchParams(await c.req.text()).entries()),
    )
    if (!form.success) return errorPage(c, 'csrf_check_failed', 403)
    const { transaction_id: transactionId, csrf_token: formCsrfToken, decision } = form.data

    const cookieCsrfToken = getCookie(c, APPROVAL_COOKIE_NAME)
    if (!cookieCsrfToken) return errorPage(c, 'csrf_check_failed', 403)

    // Read the redirect target while the transaction is still pending — after
    // approve/deny it is no longer readable, and a missing one here is also
    // how a restarted daemon (in-memory store) surfaces to the user.
    const target = options.store.getTransactionRedirect(transactionId)
    if (!target) return errorPage(c, 'transaction_not_found', 400)

    // Double submit: the cookie AND the form field must each be the value the
    // store bound to this transaction. Possession of a transaction id alone
    // authorizes nothing.
    const bound =
      options.store.verifyApprovalBinding(transactionId, cookieCsrfToken) &&
      options.store.verifyApprovalBinding(transactionId, formCsrfToken)
    if (!bound) return errorPage(c, 'csrf_check_failed', 403)

    // Re-check the stored redirect_uri against the registry rather than
    // trusting that the GET validated it: an operator can remove a client
    // between the two requests, and this is the last point before a Location
    // header is emitted.
    if (!isRegisteredRedirectUri(options.registry, target.clientId, target.redirectUri)) {
      return errorPage(c, 'redirect_uri_mismatch', 400)
    }

    // The approval session is spent either way — a decided transaction can
    // never be decided again, so leaving its cookie on the browser only keeps
    // a live secret around.
    deleteCookie(c, APPROVAL_COOKIE_NAME, { path: APPROVAL_COOKIE_PATH })

    if (decision === 'deny') {
      options.store.denyTransaction(transactionId)
      return redirectToClient(
        c,
        target.redirectUri,
        { error: 'access_denied', state: target.state },
        303,
      )
    }

    if (!options.store.approveTransaction(transactionId)) {
      return errorPage(c, 'transaction_not_found', 400)
    }
    const issued = options.store.issueAuthorizationCode(transactionId)
    if (!issued) return errorPage(c, 'transaction_not_found', 400)

    const response = redirectToClient(
      c,
      target.redirectUri,
      { code: issued.code, state: target.state },
      303,
    )
    // The Location header of this response carries the authorization code, so
    // it must not be cached, and no-referrer keeps the /authorize URL (with
    // its state and code_challenge) out of the callback's Referer. A CSP is
    // meaningless on a redirect with no body, so none is set here.
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Referrer-Policy', 'no-referrer')
    return response
  })

  app.post(OAUTH_TOKEN_PATH, oauthBodyLimit, async (c) => {
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
