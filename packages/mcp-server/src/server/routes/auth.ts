import type { MiddlewareHandler } from 'hono'
import { hasRequiredScopes } from '../security/auth-strategy.js'
import type { OAuthTransactionStore } from '../security/oauth-authz-transactions.js'
import { resolveApiRouteScope } from '../security/route-scope-registry.js'
import { timingSafeEqualStrings } from '../security/timing-safe.js'

// Returns the raw Bearer token from a well-formed `Authorization: Bearer <token>`
// header, or null for any malformed / missing input. Strict: requires exactly one
// space after "Bearer", a non-empty token, and no whitespace, commas, or quotes
// in the token (those shapes indicate multi-value or non-token inputs).
export function parseBearerAuthorizationHeader(header: string | undefined): string | null {
  if (typeof header !== 'string') return null
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length)
  if (token.length === 0 || /[\s,"]/.test(token)) return null
  return token
}

export function isAuthorized(
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  if (!token) return true
  const parsed = parseBearerAuthorizationHeader(authorization)
  return parsed !== null && timingSafeEqualStrings(parsed, token)
}

// Local-daemon mode requires the shared bearer token on every /api/* request,
// read or write. `/api/runtime/ping` is the sole exception — it is the
// availability probe apps/web calls before it knows whether a token is even
// available (see ADR-0002) — everything else under /api/runtime/* re-checks
// the bearer itself (runtime.ts), so double-gating it here is redundant but
// harmless, not a hole.
//
// Canvas/asset GET used to be carved out entirely (ADR-0002's original
// decision: loopback bind + Host-loopback check + hard-to-guess ids were
// judged sufficient, and tokenizing reads looked like it would break <img
// src> thumbnails for no real gain). That containment assumption breaks once
// a hosted origin is an admitted CORS caller (ADR-0005): an admitted origin,
// or anyone who gets past the allowlist, could then read every canvas with
// no credential at all. The client-side cost of closing this turned out to
// be zero — every read already goes through a bearer-carrying fetch
// (shared/api-client.ts's apiFetch, and every thumbnail/file consumer
// fetches bytes and renders an object URL instead of a bare <img src>) — so
// there is no reason left to leave the server side open.
export function requiresDaemonAuth(path: string): boolean {
  if (!path.startsWith('/api/')) return false
  if (path === '/api/runtime/ping') return false
  return true
}

// Is this bearer an OAuth access token whose approved grant covers the route
// being called? Two credentials reach /api/* in local-daemon mode:
//
//   - the shared daemon token, which is the machine-local operator's own
//     credential and carries full authority (it is what the daemon-served app
//     and the MCP server already hold);
//   - an OAuth access token from a hosted origin the user explicitly approved
//     (ADR-0005), which carries ONLY the scopes that approval granted.
//
// The second is the one that has to be scope-checked on every request. RFC
// 6749 §7 puts this check on the resource server, and route-scope-registry is
// where "what does this route need" is declared once. An undeclared route
// resolves to `null` there and is refused: a route added later must be given
// a scope deliberately, never inherit one by accident.
function isAuthorizedOAuthGrant(
  authorization: string | undefined,
  grantStore: OAuthTransactionStore,
  method: string,
  path: string,
): boolean {
  const presented = parseBearerAuthorizationHeader(authorization)
  if (presented === null) return false
  const grant = grantStore.verifyAccessToken(presented)
  if (grant === null) return false
  const required = resolveApiRouteScope(method, path)
  if (required === null) return false
  if (required.kind === 'public') return true
  return hasRequiredScopes(grant.scopes, required.scopes)
}

export function createDaemonAuthMiddleware(
  token?: string,
  // Absent unless the operator configured the hosted-origin OAuth surface, in
  // which case /api/* is daemon-token-only exactly as before.
  grantStore?: OAuthTransactionStore,
): MiddlewareHandler {
  return async (c, next) => {
    // The route-scope registry is the single source of truth for which routes
    // are public; consult it first so a route declared public there can never
    // be locked behind auth by a stale second list. `requiresDaemonAuth` still
    // gates everything outside `/api/*` (static app, etc.).
    if (resolveApiRouteScope(c.req.method, c.req.path)?.kind === 'public') {
      return next()
    }
    if (!requiresDaemonAuth(c.req.path)) {
      return next()
    }
    if (isAuthorized(c.req.header('authorization'), token)) {
      return next()
    }
    if (
      grantStore !== undefined &&
      isAuthorizedOAuthGrant(c.req.header('authorization'), grantStore, c.req.method, c.req.path)
    ) {
      return next()
    }
    // One rejection for every way a request can fail: no credential, a wrong
    // daemon token, a forged/expired/revoked access token, and a valid access
    // token whose grant does not cover this route. Distinguishing them —
    // even by status code — would tell an attacker which of the two
    // credentials they are close to holding, and would tell a hostile page
    // whether a given bearer is a live grant at all. (The bodies match; a
    // valid-but-out-of-scope token does run one extra O(1) hash lookup, a
    // timing delta that only matters if this daemon is ever exposed beyond
    // loopback — at which point the grant check needs a constant-time floor.)
    return c.json({ error: 'unauthorized' }, 401)
  }
}
