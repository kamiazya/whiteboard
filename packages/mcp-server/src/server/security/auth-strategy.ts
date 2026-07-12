// Auth strategy seam for the daemon's HTTP `/api/*` surface.
//
// Local-daemon mode authenticates with a single shared bearer token
// (`local-token`). The legacy `routes/auth.ts` middleware still owns
// the daemon-mutation accept/reject path verbatim — this module is a
// typed seam introduced *alongside* it so future server-mode
// strategies (`oauth-resource-server`, `pat`, `session`) can plug into
// the same call site without each route re-deriving its auth posture.
//
// A few decisions encoded in the types below:
//
//   - `AuthDecision` carries an `AuthContext` on success so downstream
//     handlers can read the authenticated subject + granted scopes
//     without re-parsing the Authorization header.
//   - The local-token strategy ignores `requiredScopes` on its success
//     path. Local-token is a single-user / single-scope concession,
//     and per-route scope enforcement is a server-mode strategy
//     responsibility (where subjects can hold less than full power).
//   - 401 vs 403 is preserved as a distinct status because RFC 7235
//     and RFC 6750 give them different operator meaning: 401 is
//     "credentials missing/invalid, retry with auth" (carries a
//     `WWW-Authenticate` challenge), 403 is "credentials understood
//     but insufficient" (no challenge — re-asking won't help).
//   - Failure decisions never quote the request token, header, path,
//     or scope list. Operator output (smokes, support bundles, CI
//     logs) captures these surfaces; leaks here would publish
//     secrets and host internals.

import type { MiddlewareHandler } from 'hono'
import { isAuthorized } from '../routes/auth.js'

// The scope vocabulary as a runtime array, not just a type: anything that
// needs to validate an externally-supplied scope string against this
// vocabulary (Zod schemas, OAuth scope-request parsing) needs a value to
// check membership against, not only a compile-time union. `AuthScope`
// is derived from this array so the two can never drift apart.
export const AUTH_SCOPES = [
  'canvas:read',
  'canvas:write',
  'workspace:read',
  'workspace:write',
  'versions:read',
  'versions:write',
  'files:read',
  'files:write',
  'runtime:read',
  'runtime:admin',
  'mcp:call',
] as const

export type AuthScope = (typeof AUTH_SCOPES)[number]

export type AuthContext =
  | { kind: 'anonymous' }
  | { kind: 'local-token' }
  | { kind: 'oauth-resource-server'; subject: string; scopes: readonly AuthScope[] }
  | { kind: 'pat'; subject: string; scopes: readonly AuthScope[] }
  | { kind: 'session'; subject: string; scopes: readonly AuthScope[] }

export interface AuthAuthorizeInput {
  method: string
  path: string
  authorizationHeader?: string
  requiredScopes: readonly AuthScope[]
}

// 401 and 403 carry distinct downstream meaning per RFC 7235 / 6750:
// 401 is "credentials missing or invalid; retry with auth" — must
// carry a `WWW-Authenticate` challenge so the client knows the
// scheme. 403 is "credentials understood but insufficient" — no
// challenge, because re-asking with the same credentials won't help.
//
// The discriminated shape below pins this 1:1 — the type system
// rejects `{ status: 401, code: 'auth.forbidden' }` and
// `{ status: 403, wwwAuthenticate: 'Bearer' }`, so the middleware
// (and any future server-mode strategy) cannot accidentally drift
// from the contract.
export type AuthDecision =
  | { ok: true; context: AuthContext }
  | {
      ok: false
      status: 401
      code: 'auth.required'
      wwwAuthenticate: 'Bearer'
    }
  | {
      ok: false
      status: 403
      code: 'auth.forbidden'
      wwwAuthenticate?: never
    }

export interface AuthStrategy {
  authorize(input: AuthAuthorizeInput): AuthDecision
}

export function createLocalTokenAuthStrategy(options: { token?: string }): AuthStrategy {
  return {
    authorize(input) {
      if (!options.token) {
        return { ok: true, context: { kind: 'anonymous' } }
      }
      if (!isAuthorized(input.authorizationHeader, options.token)) {
        return {
          ok: false,
          status: 401,
          code: 'auth.required',
          wwwAuthenticate: 'Bearer',
        }
      }
      return { ok: true, context: { kind: 'local-token' } }
      // NOTE: requiredScopes is intentionally ignored on the success
      // path. Local-token is a single-tenant concession; scope
      // enforcement lives in server-mode strategies (per the
      // `oauth-resource-server` / `pat` / `session` cases above).
    },
  }
}

export function createAuthStrategyMiddleware(options: {
  strategy: AuthStrategy
  requiredScopes: readonly AuthScope[]
}): MiddlewareHandler {
  return async (c, next) => {
    const decision = options.strategy.authorize({
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
      // The 401 variant of AuthDecision pins `wwwAuthenticate` as a
      // required `'Bearer'` literal — header is set unconditionally
      // and the value cannot be widened to leak realm / token data.
      headers.set('WWW-Authenticate', decision.wwwAuthenticate)
    }
    // Body is a constant for the failure code — no echoing of the
    // request token, header, path, or scope list. Future server-mode
    // strategies that want to surface a richer Problem Details body
    // should declare it on the strategy / decision itself, not by
    // mixing request data into the middleware response.
    return new Response(JSON.stringify({ error: decision.code }), {
      status: decision.status,
      headers,
    })
  }
}
