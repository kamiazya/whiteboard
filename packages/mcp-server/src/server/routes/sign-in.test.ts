/**
 * ADR-0046 decision 1, end to end against a provider: the keeper redirects to
 * the provider's authorization endpoint, the provider calls back with a code,
 * the keeper exchanges it (PKCE, state, nonce, ID-token signature all checked
 * by openid-client) and opens a host-only session.
 *
 * The provider is `fakeOidcProvider`, which signs and checks for real, so the
 * relying party's validation is exercised rather than stubbed.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeOidcProvider,
  fakeOidcProvider,
} from '../../shared/test-utils/fake-oidc-provider.js'
import { createAdministratorCheck } from '../security/administrator-check.js'
import { createCompleteSignInDeps } from '../security/complete-sign-in.js'
import { createRelyingParty } from '../security/oidc-relying-party.js'
import { createSignInAttemptStore } from '../security/sign-in-attempt-store.js'
import { providerAuthenticator, signInConfigSchema } from '../security/sign-in-config.js'
import { SESSION_COOKIE } from '../security/sign-in-session-store.js'
import { createTenantAdministratorStore } from '../security/tenant-administrator-store.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createSignInRoutes } from './sign-in.js'

const ISSUER = 'https://idp.test'
const BASE = 'https://board.example'
const HOUR = 60 * 60 * 1000

function providerConfig(admission: object) {
  return signInConfigSchema.parse({
    providers: [
      {
        id: 'corp',
        kind: 'oidc',
        issuer: ISSUER,
        clientId: 'wb',
        clientSecret: { env: 'CORP_SECRET' },
        admission,
      },
    ],
  }).providers
}

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let idp: FakeOidcProvider

function appFor(admission: object, fetchFn: typeof fetch = idp.fetch) {
  const db = handle.db
  const signIn = createCompleteSignInDeps(db, HOUR)
  const app = new Hono()
  app.route(
    '/',
    createSignInRoutes({
      providers: providerConfig(admission).map((p) => ({ ...p, clientSecretValue: 's3cret' })),
      rp: createRelyingParty({ fetch: fetchFn }),
      attempts: createSignInAttemptStore(db),
      signIn,
      administrators: createAdministratorCheck({
        admins: createTenantAdministratorStore(db),
        members: signIn.members,
        configured: [],
      }),
      publicBaseUrl: BASE,
    }),
  )
  return { app, signIn }
}

function cookieFrom(res: Response, name: string): string | undefined {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  return header?.slice(name.length + 1).split(';')[0]
}

async function signInThrough(app: Hono, query = '', cookieOverride?: string) {
  const started = await app.request(`${BASE}/auth/sign-in/corp${query}`)
  const binding = cookieFrom(started, '__Host-wb_signin')
  const callback = idp.authorize(started.headers.get('location') as string)
  const cookie = cookieOverride ?? `__Host-wb_signin=${binding}`
  return app.request(callback, { headers: { cookie } })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-sign-in-routes-'))
  handle = await createIsolatedDb({ dataDir: root })
  idp = await fakeOidcProvider(ISSUER, 'wb')
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('sign-in through an OIDC provider', () => {
  it('redirects to the provider with PKCE, and binds the attempt to this browser', async () => {
    const { app } = appFor({ createAccounts: true })
    const res = await app.request(`${BASE}/auth/sign-in/corp`)
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location') as string)
    expect(to.origin + to.pathname).toBe(`${ISSUER}/authorize`)
    expect(to.searchParams.get('code_challenge_method')).toBe('S256')
    expect(to.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/callback/corp`)
    expect(cookieFrom(res, '__Host-wb_signin')).toBeTruthy()
  })

  it('opens a host-only session and returns the person where they were going', async () => {
    const { app, signIn } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1', email: 'ada@corp.example', email_verified: true, name: 'Ada' })
    const res = await signInThrough(app, '?return=%2Fw%2Fplans')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/w/plans')
    const session = cookieFrom(res, SESSION_COOKIE)
    expect(session).toBeTruthy()
    expect(await signIn.sessions.resolve(session as string, Date.now())).toEqual({
      authenticator: providerAuthenticator({ issuer: ISSUER }),
      subject: 'ada-1',
    })
  })

  it('refuses a callback from a browser that did not begin the attempt', async () => {
    const { app } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' })
    const res = await signInThrough(app, '', '__Host-wb_signin=someone-else')
    expect(res.headers.get('location')).toBe('/sign-in?error=sign_in_attempt_unknown')
    expect(cookieFrom(res, SESSION_COOKIE)).toBeUndefined()
  })

  // The ID token's nonce is checked by the relying party library; a token
  // minted for another sign-in must not open a session here.
  it('refuses an ID token minted for a different sign-in', async () => {
    const { app } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' }, { nonce: 'not-this-one' })
    const res = await signInThrough(app)
    expect(res.headers.get('location')).toBe('/sign-in?error=provider_refused')
  })

  it('refuses an uninvited person on an invitation-only provider, by reason', async () => {
    const { app } = appFor({})
    idp.next({ sub: 'ada-1', email: 'ada@corp.example', email_verified: true })
    const res = await signInThrough(app)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/sign-in?error=not_invited')
  })

  it('lets an invited person in through the link they arrived with', async () => {
    const { app, signIn } = appFor({})
    const { token } = await signIn.invitations.createLink({
      invitedBy: 'p-bob',
      now: Date.now(),
      ttlMs: HOUR,
    })
    idp.next({ sub: 'ada-1', name: 'Ada' })
    const res = await signInThrough(app, `?invitation=${token}`)
    expect(res.status).toBe(302)
    expect(cookieFrom(res, SESSION_COOKIE)).toBeTruthy()
  })

  it.for([
    ['an absolute URL', 'https://evil.example/'],
    ['a scheme-relative URL', '//evil.example/'],
    ['a backslash path', '/\\evil.example'],
  ])('does not redirect to %s after signing in', async ([, target]) => {
    const { app } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' })
    const res = await signInThrough(app, `?return=${encodeURIComponent(target as string)}`)
    expect(res.headers.get('location')).toBe('/')
  })

  // The web app's sign-in screen lists these; it never learns an issuer or
  // a client id.
  it('lists the browser providers by id and display name', async () => {
    const { app } = appFor({})
    const res = await app.request(`${BASE}/auth/providers`)
    expect(await res.json()).toEqual({ providers: [{ id: 'corp', displayName: 'corp' }] })
  })

  it('answers the session this browser holds, and none without one', async () => {
    const { app, signIn } = appFor({ createAccounts: true })
    expect(await (await app.request(`${BASE}/auth/session`)).json()).toEqual({ signedIn: false })
    idp.next({ sub: 'ada-1', name: 'Ada' })
    const session = cookieFrom(await signInThrough(app), SESSION_COOKIE) as string
    const res = await app.request(`${BASE}/auth/session`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    })
    const [ada] = await signIn.members.listUsers()
    expect(await res.json()).toEqual({
      signedIn: true,
      user: { userId: ada?.id, displayName: 'Ada', administrator: false },
    })
  })

  // ADR-0049: the web app shows the people screen to an administrator only,
  // so the session says whether this person is one.
  it('says when the person signed in administers this server', async () => {
    const { app, signIn } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1', name: 'Ada' })
    const session = cookieFrom(await signInThrough(app), SESSION_COOKIE) as string
    const ada = await signIn.members.listUsers()
    await createTenantAdministratorStore(handle.db).appoint(ada[0]?.id as string, null)
    const res = await app.request(`${BASE}/auth/session`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    })
    expect(await res.json()).toMatchObject({ user: { administrator: true } })
  })

  it('returns to the sign-in screen when the provider cannot be reached', async () => {
    const { app } = appFor({ createAccounts: true }, () =>
      Promise.reject(new TypeError('fetch failed')),
    )
    const res = await app.request(`${BASE}/auth/sign-in/corp`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/sign-in?error=provider_unreachable')
  })

  it('answers an unknown provider with a JSON 404', async () => {
    const { app } = appFor({})
    const res = await app.request(`${BASE}/auth/sign-in/nobody`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unknown_provider' })
  })

  it('ends the session on sign-out', async () => {
    const { app, signIn } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' })
    const session = cookieFrom(await signInThrough(app), SESSION_COOKIE) as string
    const res = await app.request(`${BASE}/auth/sign-out`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    })
    expect(res.status).toBe(204)
    expect(await signIn.sessions.resolve(session, Date.now())).toBeNull()
  })
})
