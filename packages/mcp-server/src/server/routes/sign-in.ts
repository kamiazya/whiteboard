/**
 * ADR-0046 decision 1: sign-in at the tenant's host through a configured
 * OpenID Connect provider. Three routes and no more:
 *
 *   GET  /auth/sign-in/:providerId  — begin: redirect to the provider
 *   GET  /auth/callback/:providerId — finish: exchange, admit, open a session
 *   POST /auth/sign-out             — end this browser's session
 *
 * Everything that DECIDES is elsewhere and shared: the protocol checks are
 * the relying party's (`openid-client`), and admission, invitations and
 * account creation are `completeSignIn`'s. These routes only carry state
 * between the redirect and the callback and set the cookies.
 */

import { getConnInfo } from '@hono/node-server/conninfo'
import type {
  SignInProvidersResponse,
  SignInRefusal,
  SignInSessionResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { getLogger } from '../log.js'
import type { AdministratorCheck } from '../security/administrator-check.js'
import { type CompleteSignInDeps, completeSignIn } from '../security/complete-sign-in.js'
import type { RelyingParty, ResolvedProvider } from '../security/oidc-relying-party.js'
import type { VerifiedClaims } from '../security/sign-in-admission.js'
import type { SignInAttemptStore } from '../security/sign-in-attempt-store.js'
import type { TrustedHeaderProvider } from '../security/sign-in-config.js'
import { SESSION_COOKIE } from '../security/sign-in-session-store.js'
import {
  createTrustedIdentityReader,
  type TrustedHeaderRequest,
  type TrustedIdentity,
} from '../security/trusted-header-identity.js'

const log = getLogger('sign-in')

const ATTEMPT_COOKIE = '__Host-wb_signin'
const ATTEMPT_TTL_MS = 10 * 60 * 1000

/** A provider a person signs in with here: through a browser redirect to an
 *  OIDC provider, or through the reverse proxy in front of the keeper. */
export type SignInRouteProvider = ResolvedProvider | TrustedHeaderProvider

export interface SignInRoutesDeps {
  readonly providers: readonly SignInRouteProvider[]
  readonly rp: RelyingParty
  readonly attempts: SignInAttemptStore
  readonly signIn: CompleteSignInDeps
  /** Whether the person signed in administers this tenant (ADR-0049). */
  readonly administrators: AdministratorCheck
  /** The tenant's own origin, which the provider must redirect back to. */
  readonly publicBaseUrl: string
  readonly now?: () => number
  /** The socket's remote address. Defaults to the Node server's own. */
  readonly peerAddress?: (c: Context) => string | undefined
}

// Only a path on this origin. `//host` and `/\host` are read as another host
// by browsers, and anything absolute is somebody else's page.
function safeReturnPath(requested: string | undefined): string {
  if (requested === undefined || !requested.startsWith('/')) return '/'
  if (requested.startsWith('//') || requested.includes('\\')) return '/'
  return requested
}

const cookieOptions = { secure: true, httpOnly: true, sameSite: 'Lax', path: '/' } as const

interface Routing {
  readonly deps: SignInRoutesDeps
  readonly now: () => number
  readonly callbackUrl: (providerId: string) => string
  readonly proxied: (c: Context, provider: TrustedHeaderProvider) => Promise<TrustedIdentity>
}

async function begin(c: Context, routing: Routing, provider: SignInRouteProvider) {
  const { deps, now, callbackUrl } = routing
  const invitation = c.req.query('invitation')
  const attempt = await deps.attempts.begin({
    providerId: provider.id,
    returnTo: safeReturnPath(c.req.query('return')),
    ...(invitation === undefined ? {} : { invitationToken: invitation }),
    now: now(),
    ttlMs: ATTEMPT_TTL_MS,
  })
  setCookie(c, ATTEMPT_COOKIE, attempt.browserBinding, {
    ...cookieOptions,
    maxAge: ATTEMPT_TTL_MS / 1000,
  })
  // The proxy has already signed the person in, so there is nobody to
  // redirect to — but the attempt still goes through the callback, so a
  // proxy sign-in is bound to this browser exactly as an OIDC one is.
  if (provider.kind === 'trusted-header') {
    const to = new URL(callbackUrl(provider.id))
    to.searchParams.set('state', attempt.state)
    return c.redirect(to.toString(), 302)
  }
  // Discovery reaches the provider over the network, so an outage lands here
  // and is a reason the person can read, not a 500.
  const to = await deps.rp
    .authorizationUrl(provider, {
      redirectUri: callbackUrl(provider.id),
      state: attempt.state,
      nonce: attempt.nonce,
      codeVerifier: attempt.codeVerifier,
    })
    .catch((err: unknown) => {
      log.warning({ providerId: provider.id, err }, 'the provider could not be reached')
      return null
    })
  if (to === null) return refusedTo(c, 'provider_unreachable')
  return c.redirect(to.toString(), 302)
}

// The relying party's checks, with a failure turned into a refusal rather
// than an exception: the provider's answer is untrusted input.
async function verifiedClaims(
  c: Context,
  rp: RelyingParty,
  provider: ResolvedProvider,
  checks: { nonce: string; codeVerifier: string },
): Promise<VerifiedClaims | null> {
  try {
    return await rp.exchange(provider, new URL(c.req.url), {
      state: c.req.query('state') ?? '',
      ...checks,
    })
  } catch (err) {
    log.warning({ providerId: provider.id, err }, 'the provider answer failed a check')
    return null
  }
}

// The proxy's word, read here rather than at `begin`: the callback is the
// request that opens the session, so it is the one the proxy must vouch for.
async function proxiedClaims(
  c: Context,
  routing: Routing,
  provider: TrustedHeaderProvider,
): Promise<VerifiedClaims | null> {
  const identity = await routing.proxied(c, provider)
  if (identity.ok) return identity.claims
  log.warning({ providerId: provider.id, why: identity.why }, 'the proxy identity was refused')
  return null
}

async function finish(c: Context, routing: Routing, provider: SignInRouteProvider) {
  const { deps, now } = routing
  const attempt = await deps.attempts.take(
    c.req.query('state') ?? '',
    getCookie(c, ATTEMPT_COOKIE) ?? '',
    now(),
  )
  deleteCookie(c, ATTEMPT_COOKIE, cookieOptions)
  if (attempt === null || attempt.providerId !== provider.id) {
    return refusedTo(c, 'sign_in_attempt_unknown')
  }
  const claims =
    provider.kind === 'trusted-header'
      ? await proxiedClaims(c, routing, provider)
      : await verifiedClaims(c, deps.rp, provider, attempt)
  if (claims === null) return refusedTo(c, 'provider_refused')

  const done = await completeSignIn(deps.signIn, {
    provider,
    claims,
    ...(attempt.invitationToken === null ? {} : { invitationToken: attempt.invitationToken }),
    now: now(),
  })
  if (!done.ok) return refusedTo(c, done.reason)
  setCookie(c, SESSION_COOKIE, done.sessionToken, {
    ...cookieOptions,
    maxAge: Math.floor(deps.signIn.sessionTtlMs / 1000),
  })
  return c.redirect(attempt.returnTo, 302)
}

// A callback is a browser navigation, so a refusal goes back to the web app's
// sign-in screen, which explains the reason rather than showing raw JSON.
function refusedTo(c: Context, reason: SignInRefusal): Response {
  return c.redirect(`/sign-in?error=${reason}`, 302)
}

async function session(c: Context, deps: SignInRoutesDeps, now: () => number) {
  const token = getCookie(c, SESSION_COOKIE)
  const person = token === undefined ? null : await deps.signIn.sessions.resolve(token, now())
  const user = person === null ? null : await deps.signIn.members.profileForBinding(person)
  const body: SignInSessionResponse =
    user === null || person === null
      ? { signedIn: false }
      : {
          signedIn: true,
          user: {
            userId: user.id,
            displayName: user.displayName,
            administrator: await deps.administrators.isAdministrator(person),
          },
        }
  return c.json(body)
}

async function signOut(c: Context, deps: SignInRoutesDeps) {
  const session = getCookie(c, SESSION_COOKIE)
  if (session !== undefined) await deps.signIn.sessions.end(session)
  deleteCookie(c, SESSION_COOKIE, cookieOptions)
  return c.body(null, 204)
}

function nodePeer(c: Context): string | undefined {
  return getConnInfo(c).remote.address
}

// One reader per proxy provider, built once, so its key set is fetched once.
function proxiedReader(deps: SignInRoutesDeps): Routing['proxied'] {
  const readers = new Map(
    deps.providers
      .filter((p): p is TrustedHeaderProvider => p.kind === 'trusted-header')
      .map((p) => [p.id, createTrustedIdentityReader(p)]),
  )
  const peerOf = deps.peerAddress ?? nodePeer
  return async (c, provider) => {
    const read = readers.get(provider.id)
    if (read === undefined) return { ok: false, why: 'no_identity' }
    const request: TrustedHeaderRequest = { peer: peerOf(c), header: (name) => c.req.header(name) }
    return read(request)
  }
}

export function createSignInRoutes(deps: SignInRoutesDeps): Hono {
  const app = new Hono()
  const providerById = new Map(deps.providers.map((p) => [p.id, p]))
  const routing: Routing = {
    deps,
    now: deps.now ?? Date.now,
    callbackUrl: (id) => new URL(`/auth/callback/${id}`, deps.publicBaseUrl).toString(),
    proxied: proxiedReader(deps),
  }
  const withProvider =
    (step: (c: Context, routing: Routing, provider: SignInRouteProvider) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      const provider = providerById.get(c.req.param('providerId') ?? '')
      if (provider === undefined) return c.json({ error: 'unknown_provider' }, 404)
      return step(c, routing, provider)
    }
  const listed: SignInProvidersResponse = {
    providers: deps.providers.map((p) => ({ id: p.id, displayName: p.displayName ?? p.id })),
  }
  app.get('/auth/providers', (c) => c.json(listed))
  app.get('/auth/session', (c) => session(c, deps, routing.now))
  app.get('/auth/sign-in/:providerId', withProvider(begin))
  app.get('/auth/callback/:providerId', withProvider(finish))
  app.post('/auth/sign-out', (c) => signOut(c, deps))
  return app
}
