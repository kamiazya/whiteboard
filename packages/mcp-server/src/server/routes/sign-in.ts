/**
 * ADR-0046 decision 1: sign-in at the tenant's host through a configured
 * OpenID Connect provider:
 *
 *   GET  /auth/sign-in/:providerId  — begin: redirect to the provider
 *   GET  /auth/callback/:providerId — finish: exchange, admit, open a session
 *   GET  /auth/reauthenticate       — begin again, asking to sign in anew (ADR-0051)
 *   POST /auth/sign-out             — end this browser's session
 *
 * Everything that DECIDES is elsewhere and shared: the protocol checks are
 * the relying party's (`openid-client`), and admission, invitations and
 * account creation are `completeSignIn`'s. These routes only carry state
 * between the redirect and the callback and set the cookies.
 */

import { getConnInfo } from '@hono/node-server/conninfo'
import {
  signInPageUrl,
  signInQueryOf,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import type {
  SignInProvidersResponse,
  SignInRefusal,
  SignInSessionResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'
import { errorBody } from '@kamiazya/whiteboard-server-core'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { getLogger } from '../log.js'
import type { AdministratorCheck } from '../security/administrator-check.js'
import { type CompleteSignInDeps, completeSignIn } from '../security/complete-sign-in.js'
import { isInvitationTokenShaped } from '../security/invitation-token.js'
import type { RelyingParty, ResolvedProvider } from '../security/oidc-relying-party.js'
import type { VerifiedClaims } from '../security/sign-in-admission.js'
import type { SignInAttemptStore } from '../security/sign-in-attempt-store.js'
import { providerAuthenticator, type TrustedHeaderProvider } from '../security/sign-in-config.js'
import { SESSION_COOKIE } from '../security/sign-in-session-store.js'
import {
  createTrustedIdentityReader,
  type TrustedHeaderRequest,
  type TrustedIdentity,
} from '../security/trusted-header-identity.js'

const log = getLogger('sign-in')

const ATTEMPT_COOKIE = '__Host-wb_signin'
const ATTEMPT_TTL_MS = 10 * 60 * 1000
// A return path is a page of the web app; beginning a sign-in needs no
// credential, so a longer one is dropped rather than stored for whoever asks.
const MAX_RETURN_PATH = 2048

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

// Only a path on this origin, decided the way the browser will read it: the
// URL parser strips tab and newline and turns `\` into `/`, so `/\t/host`
// and `/\host` are another host once parsed. Resolving against our own
// origin and keeping the result only when the origin survives covers every
// such spelling; a control character is refused outright, since nothing
// legitimate carries one.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

function safeReturnPath(requested: string | undefined, publicBaseUrl: string): string {
  if (requested === undefined || !requested.startsWith('/')) return '/'
  if (requested.length > MAX_RETURN_PATH) return '/'
  if (CONTROL_CHARACTER.test(requested)) return '/'
  const ours = new URL(publicBaseUrl)
  const resolved = URL.parse(requested, ours)
  if (resolved === null || resolved.origin !== ours.origin) return '/'
  return `${resolved.pathname}${resolved.search}${resolved.hash}`
}

const cookieOptions = { secure: true, httpOnly: true, sameSite: 'Lax', path: '/' } as const

interface Routing {
  readonly deps: SignInRoutesDeps
  readonly now: () => number
  readonly callbackUrl: (providerId: string) => string
  readonly proxied: (c: Context, provider: TrustedHeaderProvider) => Promise<TrustedIdentity>
}

async function begin(c: Context, routing: Routing, provider: SignInRouteProvider, fresh = false) {
  const { deps, now, callbackUrl } = routing
  const { returnTo, invitation } = signInQueryOf((name) => c.req.query(name))
  if (invitation !== undefined && !isInvitationTokenShaped(invitation)) {
    return refusedTo(c, 'invitation_unusable')
  }
  const attempt = await deps.attempts.begin({
    providerId: provider.id,
    returnTo: safeReturnPath(returnTo, deps.publicBaseUrl),
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
      fresh,
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
//
// The exchange sends the callback's own address as `redirect_uri`, which must
// equal the authorization request's (RFC 6749 section 4.1.3). So the callback
// is read at the public address the provider redirected to, never at the
// request's: behind the TLS proxy server mode always has, that is plain http
// on an internal host.
async function verifiedClaims(
  c: Context,
  routing: Routing,
  provider: ResolvedProvider,
  checks: { nonce: string; codeVerifier: string },
): Promise<VerifiedClaims | null> {
  const callback = new URL(routing.callbackUrl(provider.id))
  callback.search = new URL(c.req.url).search
  try {
    return await routing.deps.rp.exchange(provider, callback, {
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
      : await verifiedClaims(c, routing, provider, attempt)
  if (claims === null) return refusedTo(c, 'provider_refused')

  const done = await completeSignIn(deps.signIn, {
    provider,
    claims,
    ...(attempt.invitationToken === null ? {} : { invitationToken: attempt.invitationToken }),
    now: now(),
  })
  if (!done.ok) return refusedTo(c, done.reason)
  // The cookie set below overwrites the one this browser held, and a session
  // nobody can name any more is one only a thief of the old cookie can use.
  const previous = getCookie(c, SESSION_COOKIE)
  if (previous !== undefined) await deps.signIn.sessions.end(previous)
  setCookie(c, SESSION_COOKIE, done.sessionToken, {
    ...cookieOptions,
    maxAge: Math.floor(deps.signIn.sessionTtlMs / 1000),
  })
  return c.redirect(attempt.returnTo, 302)
}

// ADR-0051 decision 5: administration asks for a recent sign-in, so a
// signed-in person is sent back to the provider they signed in with, which
// asks them to sign in again. A reverse proxy cannot be asked, and nobody
// without a session has a provider to be sent back to.
async function reauthenticate(c: Context, routing: Routing) {
  const token = getCookie(c, SESSION_COOKIE)
  const open =
    token === undefined ? null : await routing.deps.signIn.sessions.open(token, routing.now())
  const provider = routing.deps.providers.find(
    (p) => open !== null && providerAuthenticator(p) === open.person.authenticator,
  )
  if (provider === undefined || provider.kind === 'trusted-header') {
    return refusedTo(c, 'reauthentication_unavailable')
  }
  return begin(c, routing, provider, true)
}

// Sign-in and its callback are browser navigations, so a refusal goes back to the web app's
// sign-in screen, which explains the reason rather than showing raw JSON.
function refusedTo(c: Context, reason: SignInRefusal): Response {
  return c.redirect(signInPageUrl(reason), 302)
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

// The browser attaches the session cookie to a POST any page makes to this
// host — a sibling subdomain's included, which SameSite=Lax does not stop —
// so, as for every session write, only this host's own pages may sign out.
// Browsers send `Origin` on every POST, same-origin ones too.
async function signOut(c: Context, deps: SignInRoutesDeps) {
  if (c.req.header('origin') !== new URL(deps.publicBaseUrl).origin) {
    return c.json(errorBody('forbidden', 'Sign out from this server’s own pages.'), 403)
  }
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
      if (provider === undefined) return refusedTo(c, 'unknown_provider')
      return step(c, routing, provider)
    }
  const listed: SignInProvidersResponse = {
    providers: deps.providers.map((p) => ({ id: p.id, displayName: p.displayName ?? p.id })),
  }
  app.get('/auth/providers', (c) => c.json(listed))
  app.get('/auth/session', (c) => session(c, deps, routing.now))
  app.get('/auth/sign-in/:providerId', withProvider(begin))
  app.get('/auth/reauthenticate', (c) => reauthenticate(c, routing))
  app.get('/auth/callback/:providerId', withProvider(finish))
  app.post('/auth/sign-out', (c) => signOut(c, deps))
  return app
}
