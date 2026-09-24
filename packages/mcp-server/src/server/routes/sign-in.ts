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

import type {
  SignInProvidersResponse,
  SignInRefusal,
  SignInSessionResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { getLogger } from '../log.js'
import { type CompleteSignInDeps, completeSignIn } from '../security/complete-sign-in.js'
import type { RelyingParty, ResolvedProvider } from '../security/oidc-relying-party.js'
import type { VerifiedClaims } from '../security/sign-in-admission.js'
import type { SignInAttemptStore } from '../security/sign-in-attempt-store.js'
import { SESSION_COOKIE } from '../security/sign-in-session-store.js'

const log = getLogger('sign-in')

const ATTEMPT_COOKIE = '__Host-wb_signin'
const ATTEMPT_TTL_MS = 10 * 60 * 1000

export interface SignInRoutesDeps {
  readonly providers: readonly ResolvedProvider[]
  readonly rp: RelyingParty
  readonly attempts: SignInAttemptStore
  readonly signIn: CompleteSignInDeps
  /** The tenant's own origin, which the provider must redirect back to. */
  readonly publicBaseUrl: string
  readonly now?: () => number
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
}

async function begin(c: Context, { deps, now, callbackUrl }: Routing, provider: ResolvedProvider) {
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

async function finish(c: Context, { deps, now }: Routing, provider: ResolvedProvider) {
  const attempt = await deps.attempts.take(
    c.req.query('state') ?? '',
    getCookie(c, ATTEMPT_COOKIE) ?? '',
    now(),
  )
  deleteCookie(c, ATTEMPT_COOKIE, cookieOptions)
  if (attempt === null || attempt.providerId !== provider.id) {
    return refusedTo(c, 'sign_in_attempt_unknown')
  }
  const claims = await verifiedClaims(c, deps.rp, provider, attempt)
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
    user === null
      ? { signedIn: false }
      : { signedIn: true, user: { displayName: user.displayName } }
  return c.json(body)
}

async function signOut(c: Context, deps: SignInRoutesDeps) {
  const session = getCookie(c, SESSION_COOKIE)
  if (session !== undefined) await deps.signIn.sessions.end(session)
  deleteCookie(c, SESSION_COOKIE, cookieOptions)
  return c.body(null, 204)
}

export function createSignInRoutes(deps: SignInRoutesDeps): Hono {
  const app = new Hono()
  const providerById = new Map(deps.providers.map((p) => [p.id, p]))
  const routing: Routing = {
    deps,
    now: deps.now ?? Date.now,
    callbackUrl: (id) => new URL(`/auth/callback/${id}`, deps.publicBaseUrl).toString(),
  }
  const withProvider =
    (step: (c: Context, routing: Routing, provider: ResolvedProvider) => Promise<Response>) =>
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
