import type { MiddlewareHandler } from 'hono'
import { hasRequiredScopes } from '../security/auth-strategy.js'
import { parseBearerAuthorizationHeader } from '../security/bearer-token.js'
import type { CredentialResolver, ResolvedGrant } from '../security/credential-resolver.js'
import { rememberGrant } from '../security/membership-gate.js'
import { type RouteScopeDecision, resolveApiRouteScope } from '../security/route-scope-registry.js'

// Every /api/* request needs a credential the resolver accepts, read or write.
// Which routes are exempt is declared once, in `route-scope-registry.ts`, and
// the middleware below consults it before this gate — so this function is only
// the /api boundary and names no path of its own.
//
// Reads are gated too, because a narrower credential (a member's, a macaroon,
// an OAuth token) is held to its scopes on a read as well, and because being
// able to reach the transport (the owner-only socket locally, a network
// listener in server mode) is not authority to read documents. Every client
// read already goes through a bearer-carrying fetch (daemon-client's
// api-client.ts apiFetch; thumbnail and file consumers fetch bytes and render
// an object URL instead of a bare <img src>), so gating them costs nothing.
export function requiresDaemonAuth(path: string): boolean {
  return path.startsWith('/api/')
}

/**
 * Does this GRANT cover this route?
 *
 * The daemon token (and an open daemon) authorize every route without
 * consulting the registry at all — that is what "full authority" means here.
 * Every narrower credential goes through `route-scope-registry.ts`, which is
 * where "what does this route need" is declared once, and RFC 6749 §7 puts
 * this check on the resource server.
 *
 * Said once for every narrow credential rather than per credential, which is
 * the point of the resolver.
 */
export function grantCoversRoute(
  grant: ResolvedGrant,
  required: RouteScopeDecision | null,
): boolean {
  if (grant.kind === 'anonymous' || grant.kind === 'daemon-token') return true

  // An undeclared route fails closed: a route added later must be given a
  // scope deliberately, never inherit one by accident.
  if (required === null) return false
  if (required.kind === 'public') return true
  // ADR-0043 decision 8's promoted rule: a route whose whole purpose is
  // handing out daemon-level authority must not be reachable by a credential
  // narrower than what it hands out, or that credential can mint a path back
  // to the full one.
  if (required.kind === 'daemon-token-only') return false
  return hasRequiredScopes(grant.scopes, required.scopes)
}

export function createDaemonAuthMiddleware(resolver: CredentialResolver): MiddlewareHandler {
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

    const grant = await resolver.resolve({
      secret: parseBearerAuthorizationHeader(c.req.header('authorization')),
    })

    if (
      grant === null ||
      !grantCoversRoute(grant, resolveApiRouteScope(c.req.method, c.req.path))
    ) {
      // One rejection for every way a request can fail: no credential, a wrong
      // daemon token, a forged/expired/revoked access token, a valid access
      // token whose grant does not cover this route, and a macaroon that is
      // forged, expired, or caveated below what this route declares.
      // Distinguishing them — even by status code — would tell an attacker which
      // of the credentials they are close to holding, and would tell a hostile
      // page whether a given bearer is a live grant at all. (The bodies match; a
      // valid-but-out-of-scope token does run one extra O(1) hash lookup, a
      // timing delta that only matters if this daemon is ever exposed beyond
      // loopback — at which point the grant check needs a constant-time floor.)
      return c.json({ error: 'unauthorized' }, 401)
    }

    rememberGrant(c, grant)
    return next()
  }
}
