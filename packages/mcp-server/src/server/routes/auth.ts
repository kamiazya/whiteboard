import type { MiddlewareHandler } from 'hono'
import { getLogger } from '../log.js'
import { hasRequiredScopes } from '../security/auth-strategy.js'
import { parseBearerAuthorizationHeader } from '../security/bearer-token.js'
import type { CredentialResolver, ResolvedGrant } from '../security/credential-resolver.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import { membershipRefusalFor, rememberGrant } from '../security/membership-gate.js'
import { type RouteScopeDecision, resolveApiRouteScope } from '../security/route-scope-registry.js'

const _log = getLogger('daemon-auth')

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
 * the point of the resolver. It also closes a shape: the pairing token used to
 * skip this check entirely, so it alone could have reached a
 * `daemon-token-only` route. No route produces that decision today, so nothing
 * changes in behaviour — but the exemption was an omission rather than a
 * decision, and now there is nowhere for it to live.
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

/** S8 slice 2: the membership gate this middleware applies to a gated route
 *  before `next()`. Absent means no gate — a composition with no member store. */
export interface DaemonAuthGate {
  members: MemberProfileStore
}

export function createDaemonAuthMiddleware(
  resolver: CredentialResolver,
  gate?: DaemonAuthGate,
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

    const grant = await resolver.resolve({
      secret: parseBearerAuthorizationHeader(c.req.header('authorization')),
      carrier: 'bearer',
      origin: c.req.header('origin'),
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

    if (gate !== undefined) {
      const refused = await membershipRefusalFor(c, grant, gate.members)
      if (refused !== undefined) return refused
    }

    return next()
  }
}
