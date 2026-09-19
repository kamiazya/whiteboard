/**
 * One place that answers "what does this credential carry".
 *
 * Every auth surface in this daemon used to hold its own copy of the
 * credential branches, each behind an OPTIONAL positional parameter — four on
 * `createDaemonAuthMiddleware`, five on `authorizeWsUpgrade`. That shape makes
 * "the composition root forgot this argument" and "this daemon mints no
 * macaroons" the same call, and it shipped exactly that defect: the macaroon
 * root key reached production with no caller while 39 tests reported the
 * feature working, on two surfaces, twice.
 *
 * So the branches live here and the resolver is a REQUIRED argument at every
 * surface. A silently missing credential on one surface becomes either a type
 * error or a gap on every surface at once, which one end-to-end test catches.
 *
 * **It answers a GRANT, not a yes/no.** `auth-strategy.ts` attempted this
 * unification before and returned a verdict; the websocket upgrade needed the
 * SCOPES, so it grew its own branches instead and the seam was adopted by
 * nothing. That is why this one can be adopted where that one could not.
 *
 * What deliberately does NOT move here, because the surfaces genuinely differ:
 *
 * - **the carrier** — `Authorization: Bearer` on HTTP, a
 *   `Sec-WebSocket-Protocol` entry on the upgrade. Each surface extracts its
 *   own secret and says which carrier it came from.
 * - **the scope policy** — `/api/*` checks `route-scope-registry.ts` at the
 *   gate; the websocket checks nothing there because `routes/ws.ts` enforces
 *   per operation downstream; `/mcp` wants `mcp:call`.
 * - **the refusal shape** — a Hono JSON 401, a `{ accept: false, statusCode }`
 *   decision, a JSON-RPC `-32000` body, and whether a `WWW-Authenticate`
 *   challenge is attached.
 *
 * Collapsing those three would be the opposite mistake to the one this fixes.
 */
import { ALL_AUTH_SCOPES, type AuthScope } from './auth-strategy.js'
import { isAuthorized } from './bearer-token.js'
import { verifyMacaroon } from './macaroon.js'
import type { OAuthTransactionStore } from './oauth-authz-transactions.js'

export type GrantKind =
  /** No daemon token is configured, so every caller holds everything. */
  'anonymous' | 'daemon-token' | 'oauth-grant' | 'pairing' | 'ws-ticket' | 'macaroon'

export interface ResolvedGrant {
  readonly kind: GrantKind
  /**
   * What the holder may do. Only `anonymous`, `daemon-token` and `pairing`
   * carry the full set today; `pairing` doing so is the current state of the
   * world rather than a decision, and narrowing it is its own increment.
   */
  readonly scopes: readonly AuthScope[]
  /** Who the credential names, where it names anyone (an OAuth client). */
  readonly subject?: string
}

/**
 * Which slot the secret arrived in. Not cosmetic: a ws connection ticket is
 * SINGLE-USE, so a resolver that tried the ticket branch on every secret would
 * burn a live ticket on a request that never claimed to be one.
 */
export type CredentialCarrier = 'bearer' | 'ws-subprotocol' | 'ws-ticket'

export interface PresentedCredential {
  /** `null` when the request carried no credential at all. */
  readonly secret: string | null
  readonly carrier: CredentialCarrier
  /** The browser-enforced Origin, when the request had one. */
  readonly origin?: string
  readonly now?: number
}

export interface CredentialResolver {
  resolve(presented: PresentedCredential): Promise<ResolvedGrant | null>
}

export type RedeemTicketFn = (ticket: string) => {
  scopes: readonly AuthScope[]
  clientId: string
} | null

export interface CredentialResolverConfig {
  /** Absent means an OPEN daemon: every caller resolves to `anonymous`. */
  daemonToken?: string
  /** Absent unless the operator configured the hosted-origin OAuth surface. */
  grantStore?: Pick<OAuthTransactionStore, 'verifyAccessToken'>
  pairingTokens?: { validate(token: string, origin: string): boolean }
  redeemTicket?: RedeemTicketFn
  /** Absent until a composition root supplies one (ADR-0043 decision 9). */
  macaroonRootKey?: Uint8Array
}

export function createCredentialResolver(config: CredentialResolverConfig): CredentialResolver {
  return {
    async resolve({ secret, carrier, origin, now = Date.now() }) {
      // An open daemon is open whatever was presented, including nothing.
      // This is `isAuthorized`'s own "no token configured → true", said once.
      if (!config.daemonToken) {
        return { kind: 'anonymous', scopes: ALL_AUTH_SCOPES }
      }
      if (secret === null) return null

      // A ticket is its own lane in both directions: only tried when offered
      // as one, and never falling through to the other credentials when it
      // fails. A secret offered as a ticket is a claim about what it is, and a
      // failed claim is a malformed offer rather than something to keep
      // guessing at.
      if (carrier === 'ws-ticket') {
        const redeemed = config.redeemTicket?.(secret) ?? null
        if (redeemed === null) return null
        return { kind: 'ws-ticket', scopes: redeemed.scopes, subject: redeemed.clientId }
      }

      // Order is a cost decision. The two credentials that authorize
      // everything come first so they never pay for the verification of the
      // ones that do not, and the macaroon is last because its check is the
      // only one that computes an HMAC chain.
      if (isAuthorized(`Bearer ${secret}`, config.daemonToken)) {
        return { kind: 'daemon-token', scopes: ALL_AUTH_SCOPES }
      }

      if (config.grantStore !== undefined) {
        const grant = config.grantStore.verifyAccessToken(secret)
        if (grant !== null) {
          return { kind: 'oauth-grant', scopes: grant.scopes, subject: grant.clientId }
        }
      }

      if (config.pairingTokens !== undefined && origin !== undefined) {
        let normalized: string | null = null
        try {
          normalized = new URL(origin).origin
        } catch {
          normalized = null
        }
        if (normalized !== null && config.pairingTokens.validate(secret, normalized)) {
          return { kind: 'pairing', scopes: ALL_AUTH_SCOPES }
        }
      }

      if (config.macaroonRootKey !== undefined) {
        // No `requiredScopes` here: what a holder may do is the surface's
        // question, and this one only establishes that the token is genuine,
        // unexpired, and carries the scopes it claims.
        const verdict = await verifyMacaroon({
          token: secret,
          rootKey: config.macaroonRootKey,
          context: { requiredScopes: [], now },
        })
        if (verdict.ok) {
          return { kind: 'macaroon', scopes: verdict.scopes }
        }
      }

      return null
    },
  }
}
