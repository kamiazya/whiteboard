// The scope vocabulary, and the decision shape a server-mode auth strategy
// answers with.
//
// This file USED to carry a sync `AuthStrategy` seam as well —
// `createLocalTokenAuthStrategy` and `createAuthStrategyMiddleware` — with a
// header promising that "future server-mode strategies can plug into the same
// call site". They were mounted nowhere, for the whole of their life, and the
// reason is worth keeping: **they answered a yes/no.** A surface that already
// knows the answer is yes still has to learn what the caller may DO, and the
// websocket upgrade needed exactly that, so it grew its own credential
// branches instead. A seam that answers the wrong question is not adopted, and
// being unadopted is how it stayed wrong.
//
// `security/credential-resolver.ts` is the replacement, and it answers a
// GRANT. The sync seam was deleted rather than left beside it: two components
// for one job is the shape this work exists to remove.
//
// What stayed, because it has real callers:
//
//   - `AUTH_SCOPES` / `AuthScope` / `ALL_AUTH_SCOPES` / `hasRequiredScopes` —
//     the vocabulary, read by the resolver, the route-scope registry, the
//     macaroon caveats and the OAuth grant store.
//   - `AuthAuthorizeInput` / `AuthDecision` / `AuthContext` — the shape
//     `oauth-resource-strategy.ts`'s `AsyncAuthStrategy` answers with, which
//     server-mode really does mount. 401 vs 403 stays pinned 1:1 to its code
//     and challenge header there for RFC 7235 / 6750's reason: 401 is
//     "credentials missing or invalid, retry with auth" and carries a
//     `WWW-Authenticate` challenge; 403 is "understood but insufficient" and
//     must not, because re-asking will not help.
//   - Failure decisions never quote the request token, header, path or scope
//     list. Operator output (smokes, support bundles, CI logs) captures these
//     surfaces.

// The scope vocabulary as a runtime array, not just a type: anything that
// needs to validate an externally-supplied scope string against this
// vocabulary (Zod schemas, OAuth scope-request parsing) needs a value to
// check membership against, not only a compile-time union. `AuthScope`
// is derived from this array so the two can never drift apart.
import type { BearerToken } from './bearer-provisioning.js'
import type { AuthenticatorBinding } from './member-profile-store.js'

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

// What "this credential can do anything" means, in one place: the daemon
// token, an open daemon, and (for now) a pairing token all resolve to it.
// Derived directly from `AUTH_SCOPES` so adding a scope to the vocabulary can
// never leave the full grant set silently under-provisioned.
export const ALL_AUTH_SCOPES: readonly AuthScope[] = AUTH_SCOPES

// RFC 6749 §3.3 leaves scope semantics to the resource server; ours is
// conjunctive — a route that declares two scopes needs both, and a credential
// that holds a superset of them is still fine. Absence of any required scope
// is a decision (the route is public), not a wildcard.
export function hasRequiredScopes(
  granted: readonly AuthScope[],
  required: readonly AuthScope[],
): boolean {
  return required.every((scope) => granted.includes(scope))
}

type AuthContext =
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
  | {
      ok: true
      context: AuthContext
      /** Who the credential names, as an account binding (ADR-0045 d15) —
       *  absent for one that names no person. Kept BESIDE the context, not in
       *  it: it spells the issuer, and the context is what downstream code
       *  may log or serialise. It exists to resolve a person, nothing else. */
      person?: AuthenticatorBinding
      /** The verified bearer token behind `person`, read only when that
       *  person has no user yet (ADR-0046 decision 5). */
      bearer?: () => BearerToken
    }
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
