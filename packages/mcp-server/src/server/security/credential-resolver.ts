/**
 * One place that answers "what does this credential carry".
 *
 * Every auth surface in this daemon used to hold its own copy of the
 * credential branches, each behind an OPTIONAL positional parameter. That shape makes
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
 * unification before and returned a verdict; a surface that needed the
 * SCOPES grew its own branches instead and the seam was adopted by nothing.
 * That is why this one can be adopted where that one could not.
 *
 * What deliberately does NOT move here, because the surfaces genuinely differ:
 *
 * - **the scope policy** — `/api/*` checks `route-scope-registry.ts` at the
 *   gate; `/mcp` wants `mcp:call`.
 * - **the refusal shape** — a Hono JSON 401, a JSON-RPC `-32000` body, and
 *   whether a `WWW-Authenticate` challenge is attached.
 *
 * Collapsing them would be the opposite mistake to the one this fixes.
 */
import { ALL_AUTH_SCOPES, type AuthScope } from './auth-strategy.js'
import { isAuthorized } from './bearer-token.js'
import { verifyMacaroon } from './macaroon.js'
import type { AuthenticatorBinding } from './member-profile-store.js'

type GrantKind =
  /** No daemon token is configured, so every caller holds everything. */
  | 'anonymous'
  | 'daemon-token'
  | 'macaroon'
  /** Server mode (ADR-0046): a session opened by signing in at this host. */
  | 'signed-in'
  /** Server mode: an access token from the configured issuer, naming a person. */
  | 'external-bearer'

export interface ResolvedGrant {
  readonly kind: GrantKind
  /** What the holder may do. `anonymous` and `daemon-token` carry the full set. */
  readonly scopes: readonly AuthScope[]
  /** Who an authenticator vouched for, when the credential names a PERSON —
   *  server mode's signed-in person. */
  readonly person?: AuthenticatorBinding
  /** A `signed-in` grant only: when the person's provider last authenticated
   *  them (ADR-0051), null when it did not say. Administration reads it. */
  readonly authenticatedAt?: number | null
}

interface PresentedCredential {
  /** `null` when the request carried no credential at all. */
  readonly secret: string | null
  readonly now?: number
}

export interface CredentialResolver {
  resolve(presented: PresentedCredential): Promise<ResolvedGrant | null>
}

export interface CredentialResolverConfig {
  /**
   * Absent means an OPEN daemon: every caller resolves to `anonymous`. An empty
   * string is NOT absent — it is a configured token no bearer can match, so
   * nothing resolves.
   */
  daemonToken?: string
  /** Absent until a composition root supplies one (ADR-0043 decision 9). */
  macaroonRootKey?: Uint8Array
}

/** One credential family's verification: the grant it establishes, or null. */
type CredentialAttempt = (
  secret: string,
  config: CredentialResolverConfig,
  now: number,
) => ResolvedGrant | null | Promise<ResolvedGrant | null>

const daemonTokenAttempt: CredentialAttempt = (secret, config) => {
  // Guarded on `daemonToken` being set, because `isAuthorized` answers TRUE
  // for any secret when no token is configured — which would make an open
  // daemon report every bearer as the daemon token.
  if (config.daemonToken === undefined) return null
  return isAuthorized(`Bearer ${secret}`, config.daemonToken)
    ? { kind: 'daemon-token', scopes: ALL_AUTH_SCOPES }
    : null
}

const macaroonAttempt: CredentialAttempt = async (secret, config, now) => {
  if (config.macaroonRootKey === undefined) return null
  // No `requiredScopes` here: what a holder may do is the surface's question,
  // and this one only establishes that the token is genuine, unexpired, and
  // carries the scopes it claims.
  const verdict = await verifyMacaroon({
    token: secret,
    rootKey: config.macaroonRootKey,
    context: { requiredScopes: [], now },
  })
  return verdict.ok ? { kind: 'macaroon', scopes: verdict.scopes } : null
}

/**
 * The order is a cost decision, which is why it is a list rather than a chain
 * of branches: the credential that authorizes everything comes first so it
 * never pays for the verification of the one that does not, and the macaroon
 * computes an HMAC chain.
 */
const BEARER_ATTEMPTS: readonly CredentialAttempt[] = [daemonTokenAttempt, macaroonAttempt]

async function resolvePresented(
  config: CredentialResolverConfig,
  { secret, now = Date.now() }: PresentedCredential,
): Promise<ResolvedGrant | null> {
  if (secret !== null) {
    for (const attempt of BEARER_ATTEMPTS) {
      const grant = await attempt(secret, config, now)
      if (grant !== null) return grant
    }
  }

  // Nothing identified the secret. A daemon with no token configured
  // requires no credential at all, so the caller holds everything — this
  // is `isAuthorized`'s own "no token configured → true", said once.
  //
  // It is a FALLBACK rather than a shortcut, and that ordering is
  // load-bearing: answering `anonymous` first would shadow a credential that
  // was presented and does verify, and a surface that asks WHICH credential
  // is asking would then be told nothing.
  if (config.daemonToken === undefined) {
    return { kind: 'anonymous', scopes: ALL_AUTH_SCOPES }
  }
  return null
}

export function createCredentialResolver(config: CredentialResolverConfig): CredentialResolver {
  return { resolve: (presented) => resolvePresented(config, presented) }
}
