// OAuth 2.1 resource-server validation seam.
//
// Goal: a typed seam that fits inside the existing `AuthDecision`
// contract so future server-mode work can plug in an external IdP's
// access-token validator (`oauth4webapi` + `jose`, or a vendor SDK)
// without re-deriving how 401 / 403 / `WWW-Authenticate` should be
// emitted. This module ships the seam only — there is no signature
// verification, no JWKS fetch, no issuer probe. A real validator is
// a separate slice; this seam is what that validator plugs into.
//
// Why a separate module from `auth-strategy.ts`:
//   - JWT validation is genuinely asynchronous (signature, JWKS
//     fetch, key cache). The local-token strategy is synchronous and
//     its test surface intentionally calls `authorize()` without
//     `await`. A unified async signature would either break those
//     tests or force them to await every call. A sibling
//     `AsyncAuthStrategy` interface keeps both shapes honest.
//   - This module owns the validator adapter contract — the failure
//     vocabulary that maps to 401 vs 403, the scope vocabulary, and
//     the auth-context shape. Keeping it next to the local-token
//     strategy in one file would conflate two responsibilities.
//
// Failure-reason → HTTP status mapping (locked by tests):
//
//   401 auth.required   ─ missing | malformed | invalid_signature
//                        | invalid_issuer | invalid_audience
//                        | expired | revoked | validator_unavailable
//                        | not_access_token
//   403 auth.forbidden  ─ insufficient_scope
//
// 401 is "credentials missing or invalid; retry with auth" — a
// `WWW-Authenticate: Bearer` challenge ships, per RFC 7235 / 6750.
// 403 is "credentials understood but insufficient" — no challenge,
// because re-presenting the same credentials cannot satisfy the
// missing scope. The discriminated `AuthDecision` shape pins this
// 1:1; the strategy here just selects the right variant.
//
// Defence-in-depth: even if a validator returns `ok: true` with
// scopes narrower than `requiredScopes`, the strategy re-checks the
// subset relation at the boundary and emits 403 forbidden. A buggy
// or compromised validator should not be able to bypass the
// route-level scope contract.

import type { MiddlewareHandler } from 'hono'
import type { AuthAuthorizeInput, AuthDecision, AuthScope } from './auth-strategy.js'
import { parseBearerAuthorizationHeader } from './bearer-token.js'

type OAuthResourceTokenValidationFailureReason =
  | 'missing'
  | 'malformed'
  | 'invalid_signature'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'expired'
  | 'insufficient_scope'
  | 'revoked'
  | 'validator_unavailable'
  | 'not_access_token'

export interface OAuthResourceTokenValidationInput {
  token: string
  requiredScopes: readonly AuthScope[]
}

export type OAuthResourceTokenValidationResult =
  | {
      ok: true
      subject: string
      issuer: string
      audience: string | readonly string[]
      scopes: readonly AuthScope[]
      expiresAt?: number
    }
  | {
      ok: false
      reason: OAuthResourceTokenValidationFailureReason
    }

export interface OAuthResourceTokenValidator {
  validate(input: OAuthResourceTokenValidationInput): Promise<OAuthResourceTokenValidationResult>
}

export interface AsyncAuthStrategy {
  authorize(input: AuthAuthorizeInput): Promise<AuthDecision>
}

const UNAUTHORIZED: AuthDecision = {
  ok: false,
  status: 401,
  code: 'auth.required',
  wwwAuthenticate: 'Bearer',
}

const FORBIDDEN: AuthDecision = {
  ok: false,
  status: 403,
  code: 'auth.forbidden',
}

export function createOAuthResourceServerAuthStrategy(options: {
  validator: OAuthResourceTokenValidator
}): AsyncAuthStrategy {
  return {
    async authorize(input) {
      const token = parseBearerAuthorizationHeader(input.authorizationHeader)
      if (token === null) {
        return UNAUTHORIZED
      }
      let result: OAuthResourceTokenValidationResult
      try {
        result = await options.validator.validate({
          token,
          requiredScopes: input.requiredScopes,
        })
      } catch {
        // Validator threw (network error, JWKS fetch failure, parse
        // error, etc.). Treat as validator_unavailable → 401. The
        // error message is intentionally discarded — it may contain
        // IdP URLs, stack frames, or partial token data.
        return UNAUTHORIZED
      }
      if (!result.ok) {
        switch (result.reason) {
          case 'insufficient_scope':
            return FORBIDDEN
          case 'missing':
          case 'malformed':
          case 'invalid_signature':
          case 'invalid_issuer':
          case 'invalid_audience':
          case 'expired':
          case 'revoked':
          case 'validator_unavailable':
          case 'not_access_token':
            return UNAUTHORIZED
          default: {
            const _exhaustive: never = result.reason
            void _exhaustive
            return UNAUTHORIZED
          }
        }
      }
      // Scope subset enforcement at the strategy boundary — the
      // validator's `ok` is only one of two checks, the route's
      // `requiredScopes` is the other.
      const granted = new Set<string>(result.scopes)
      for (const required of input.requiredScopes) {
        if (!granted.has(required)) {
          return FORBIDDEN
        }
      }
      return {
        ok: true,
        context: {
          kind: 'oauth-resource-server',
          subject: result.subject,
          // Surface only `subject` + `scopes` in the auth context.
          // Issuer / audience are validator-internal: leaking them
          // into downstream handlers (and into anything that
          // serialises `decision.context`) would publish IdP URLs
          // and internal resource ids onto operator-facing surfaces.
          scopes: result.scopes,
        },
      }
    },
  }
}

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
