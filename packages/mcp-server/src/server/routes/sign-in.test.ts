/**
 * ADR-0046 decision 1, end to end against a provider: the keeper redirects to
 * the provider's authorization endpoint, the provider calls back with a code,
 * the keeper exchanges it (PKCE, state, nonce, ID-token signature all checked
 * by openid-client) and opens a host-only session.
 *
 * The provider is `fakeOidcProvider`, which signs and checks for real, so the
 * relying party's validation is exercised rather than stubbed.
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invitePageUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { signInRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'
import { Hono } from 'hono'
import type { CustomFetch } from 'openid-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeOidcProvider,
  fakeOidcProvider,
} from '../../shared/test-utils/fake-oidc-provider.js'
import { captureLogsForTests } from '../log.js'
import { oidcProviders, resolvedForTest } from '../security/_test-helpers.js'
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
  return oidcProviders(
    signInConfigSchema.parse({
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
    }).providers,
  )
}

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let idp: FakeOidcProvider

interface AttemptLimits {
  readonly maxPending: number
  readonly peer: () => string
}

function appFor(
  admission: object,
  fetchFn: CustomFetch = idp.fetch,
  now?: () => number,
  limits?: AttemptLimits,
) {
  const db = handle.db
  const signIn = createCompleteSignInDeps(db, HOUR)
  const app = new Hono()
  app.route(
    '/',
    createSignInRoutes({
      providers: providerConfig(admission).map(resolvedForTest),
      rp: createRelyingParty({ fetch: fetchFn }),
      attempts: createSignInAttemptStore(
        db,
        limits === undefined ? {} : { maxPending: limits.maxPending },
      ),
      signIn,
      administrators: createAdministratorCheck({
        admins: createTenantAdministratorStore(db),
        members: signIn.members,
        configured: [],
      }),
      publicBaseUrl: BASE,
      ...(now === undefined ? {} : { now }),
      ...(limits === undefined ? {} : { peerAddress: limits.peer }),
    }),
  )
  return { app, signIn }
}

function cookieFrom(res: Response, name: string): string | undefined {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  return header?.slice(name.length + 1).split(';')[0]
}

async function signInThrough(
  app: Hono,
  query = '',
  cookieOverride?: string,
  beforeCallback?: () => void,
) {
  const started = await app.request(`${BASE}/auth/sign-in/corp${query}`)
  const binding = cookieFrom(started, '__Host-wb_signin')
  const callback = idp.authorize(started.headers.get('location') as string)
  beforeCallback?.()
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

  // Server mode serves plain http behind the TLS proxy its https external URL
  // requires, so the callback arrives at an address the provider never saw.
  // The exchange must still name the redirect URI the authorization did.
  it('completes a sign-in whose callback arrives through a TLS-terminating proxy', async () => {
    const { app } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' })
    const started = await app.request(`${BASE}/auth/sign-in/corp`)
    const binding = cookieFrom(started, '__Host-wb_signin')
    const callback = new URL(idp.authorize(started.headers.get('location') as string))
    const behindProxy = `http://127.0.0.1:8080${callback.pathname}${callback.search}`
    const res = await app.request(behindProxy, {
      headers: { cookie: `__Host-wb_signin=${binding}` },
    })
    expect(res.headers.get('location')).toBe('/')
    expect(cookieFrom(res, SESSION_COOKIE)).toBeTruthy()
  })

  // ADR-0051 decision 5: administration asks for a recent sign-in at the
  // provider, so a signed-in person can be sent back to sign in again —
  // interactively, whatever session the provider still holds.
  it('re-authenticates a signed-in person at their provider and records when', async () => {
    const { app, signIn } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' })
    const first = cookieFrom(await signInThrough(app), SESSION_COOKIE) as string
    const plain = new URL(
      (await app.request(`${BASE}/auth/sign-in/corp`)).headers.get('location') as string,
    )
    expect(plain.searchParams.get('prompt')).toBeNull()

    const started = await app.request(`${BASE}/auth/reauthenticate?return=%2Fpeople`, {
      headers: { cookie: `${SESSION_COOKIE}=${first}` },
    })
    const to = new URL(started.headers.get('location') as string)
    expect(to.origin + to.pathname).toBe(`${ISSUER}/authorize`)
    expect(to.searchParams.get('prompt')).toBe('login')
    expect(to.searchParams.get('max_age')).toBe('0')

    const now = Math.floor(Date.now() / 1000)
    idp.next({ sub: 'ada-1', auth_time: now })
    const binding = cookieFrom(started, '__Host-wb_signin')
    const done = await app.request(idp.authorize(to.toString()), {
      headers: { cookie: `__Host-wb_signin=${binding}` },
    })
    expect(done.headers.get('location')).toBe('/people')
    const session = cookieFrom(done, SESSION_COOKIE) as string
    expect((await signIn.sessions.open(session, Date.now()))?.authenticatedAt).toBe(now * 1000)
  })

  it('sends someone with no session to the sign-in screen rather than a provider', async () => {
    const { app } = appFor({ createAccounts: true })
    const res = await app.request(`${BASE}/auth/reauthenticate`)
    expect(res.headers.get('location')).toBe('/sign-in?error=reauthentication_unavailable')
  })

  // The attempt is the only thing between a callback and a session, so its
  // lifetime is what bounds a stolen `state`. The routes' own default is under
  // test here: the stores are handed no lifetime by the caller.
  describe('the attempt lifetime', () => {
    const TEN_MINUTES = 10 * 60 * 1000

    it('is ten minutes: the callback one millisecond short of that still signs in', async () => {
      let clock = Date.parse('2030-01-01T00:00:00Z')
      const { app } = appFor({ createAccounts: true }, idp.fetch, () => clock)
      idp.next({ sub: 'ada-1' })
      const res = await signInThrough(app, '', undefined, () => {
        clock += TEN_MINUTES - 1
      })
      expect(cookieFrom(res, SESSION_COOKIE)).toBeTruthy()
    })

    it('is ten minutes: the callback at that moment is refused as an unknown attempt', async () => {
      let clock = Date.parse('2030-01-01T00:00:00Z')
      const { app } = appFor({ createAccounts: true }, idp.fetch, () => clock)
      idp.next({ sub: 'ada-1' })
      const res = await signInThrough(app, '', undefined, () => {
        clock += TEN_MINUTES
      })
      expect(res.headers.get('location')).toBe('/sign-in?error=sign_in_attempt_unknown')
      expect(cookieFrom(res, SESSION_COOKIE)).toBeUndefined()
    })

    it('is the lifetime of the cookie that carries the browser binding', async () => {
      const { app } = appFor({ createAccounts: true })
      const started = await app.request(`${BASE}/auth/sign-in/corp`)
      const line = started.headers.getSetCookie().find((c) => c.startsWith('__Host-wb_signin='))
      expect(line?.split('; ')).toContain(`Max-Age=${TEN_MINUTES / 1000}`)
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
    const bob = await signIn.members.ensureProfile({
      binding: { authenticator: 'oidc:https://other.example', subject: 'bob' },
      displayName: 'Bob',
    })
    await createTenantAdministratorStore(handle.db).appoint(bob.id, null)
    const { token } = await signIn.invitations.createLink({
      invitedBy: bob.id,
      now: Date.now(),
      ttlMs: HOUR,
    })
    idp.next({ sub: 'ada-1', name: 'Ada' })
    const res = await signInThrough(app, `?invitation=${token}`)
    expect(res.status).toBe(302)
    expect(cookieFrom(res, SESSION_COOKIE)).toBeTruthy()
  })

  // A link straight to the begin route skips the invite page's click, so a
  // page on another site could otherwise join a person already signed in at
  // the provider to a workspace of its choosing and land them in it.
  describe('an invitation begun from another site', () => {
    async function workspaceInvitation(signIn: ReturnType<typeof appFor>['signIn']) {
      const owner = await signIn.members.ensureProfile({
        binding: { authenticator: 'oidc:https://other.example', subject: 'owner' },
        displayName: 'Owner',
      })
      await signIn.members.addMember('ws-attacker', owner.id)
      const { token } = await signIn.invitations.createLink({
        invitedBy: owner.id,
        workspaceId: 'ws-attacker',
        now: Date.now(),
        ttlMs: HOUR,
      })
      return token
    }

    async function existingAda(app: Hono, signIn: ReturnType<typeof appFor>['signIn']) {
      idp.next({ sub: 'ada-1' })
      await signInThrough(app)
      const ada = await signIn.members.profileForBinding({
        authenticator: providerAuthenticator(providerConfig({ createAccounts: true })[0]!),
        subject: 'ada-1',
      })
      if (ada === null) throw new Error('the first sign-in made no user')
      return ada
    }

    it('is sent to the invite page to be accepted there, joining nobody', async () => {
      const { app, signIn } = appFor({ createAccounts: true })
      const ada = await existingAda(app, signIn)
      const token = await workspaceInvitation(signIn)
      const res = await app.request(
        `${BASE}/auth/sign-in/corp?invitation=${token}&return=%2Fw%2Fws-attacker`,
        { headers: { 'sec-fetch-site': 'cross-site' } },
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(invitePageUrl(BASE, token))
      expect(cookieFrom(res, '__Host-wb_signin')).toBeUndefined()
      expect(await signIn.members.isWorkspaceMember('ws-attacker', ada.id)).not.toBe('member')
      expect((await signIn.invitations.openLink(token, Date.now())).ok).toBe(true)
    })

    it.for([
      'same-origin',
      'none',
      undefined,
    ])('joins the workspace when Sec-Fetch-Site is %s', async (site) => {
      const { app, signIn } = appFor({ createAccounts: true })
      const ada = await existingAda(app, signIn)
      const token = await workspaceInvitation(signIn)
      const started = await app.request(`${BASE}/auth/sign-in/corp?invitation=${token}`, {
        headers: site === undefined ? {} : { 'sec-fetch-site': site },
      })
      idp.next({ sub: 'ada-1' })
      const res = await app.request(idp.authorize(started.headers.get('location') as string), {
        headers: { cookie: `__Host-wb_signin=${cookieFrom(started, '__Host-wb_signin')}` },
      })
      expect(cookieFrom(res, SESSION_COOKIE)).toBeTruthy()
      expect(await signIn.members.isWorkspaceMember('ws-attacker', ada.id)).toBe('member')
    })

    it('still begins a plain sign-in from another site', async () => {
      const { app } = appFor({ createAccounts: true })
      const res = await app.request(`${BASE}/auth/sign-in/corp`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      expect(new URL(res.headers.get('location') as string).origin).toBe(ISSUER)
    })
  })

  it.for([
    ['an absolute URL', 'https://evil.example/'],
    ['a scheme-relative URL', '//evil.example/'],
    ['a backslash path', '/\\evil.example'],
    ['a path that a stripped tab makes scheme-relative', '/\t/evil.example'],
    ['a path that a stripped newline makes scheme-relative', '/\n/evil.example'],
    ['a path that a stripped carriage return makes scheme-relative', '/\r//evil'],
    ['a dot segment the parser collapses to scheme-relative', '/.//evil.example'],
    ['an encoded dot segment collapsing to scheme-relative', '/%2e//evil.example'],
    ['a parent segment collapsing to scheme-relative', '/a/..//evil.example'],
    ['a dot segment before a backslash', '/./\\evil.example'],
  ])('does not redirect to %s after signing in', async ([, target]) => {
    const { app } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' })
    const res = await signInThrough(app, `?return=${encodeURIComponent(target as string)}`)
    expect(res.headers.get('location')).toBe('/')
  })

  it('finishes a sign-in begun before another client filled the attempt ceiling', async () => {
    let peer = '203.0.113.7'
    const { app } = appFor({ createAccounts: true }, idp.fetch, undefined, {
      maxPending: 5,
      peer: () => peer,
    })
    const started = await app.request(`${BASE}/auth/sign-in/corp`)
    const binding = cookieFrom(started, '__Host-wb_signin')
    peer = '198.51.100.9'
    for (let i = 0; i < 12; i++) await app.request(`${BASE}/auth/sign-in/corp`)
    idp.next({ sub: 'ada-1' })
    const callback = idp.authorize(started.headers.get('location') as string)
    const res = await app.request(callback, { headers: { cookie: `__Host-wb_signin=${binding}` } })
    expect(cookieFrom(res, SESSION_COOKIE)).toBeTruthy()
  })

  // Beginning a sign-in needs no credential and stores a row, so what one
  // request can make the keeper hold is bounded by the route, not by the
  // header limit of whatever server is in front.
  describe('what an unauthenticated begin can store', () => {
    const SIXTY_FOUR_KB = 64 * 1024
    const stored = () => handle.rawDb.selectFrom('signInAttempts').selectAll().execute()

    it('keeps a return path up to 2048 characters and drops a longer one', async () => {
      const { app } = appFor({ createAccounts: true })
      const longest = `/${'a'.repeat(2047)}`
      for (const target of [longest, `/${'a'.repeat(SIXTY_FOUR_KB)}`]) {
        await app.request(`${BASE}/auth/sign-in/corp?return=${encodeURIComponent(target)}`)
      }
      expect((await stored()).map((row) => row.returnTo).sort()).toEqual(['/', longest].sort())
    })

    it.for([
      ['a 64 KB value', 'x'.repeat(64 * 1024)],
      ['a value one character past the token', 'A'.repeat(44)],
      ['a value outside the token alphabet', `${'A'.repeat(42)}=`],
    ])('refuses an invitation that is %s and stores nothing', async ([, invitation]) => {
      const { app } = appFor({ createAccounts: true })
      const res = await app.request(
        `${BASE}/auth/sign-in/corp?invitation=${encodeURIComponent(invitation as string)}`,
      )
      expect(res.headers.get('location')).toBe('/sign-in?error=invitation_unusable')
      expect(await stored()).toEqual([])
    })
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

  // A provider's failed answer can carry tokens, and openid-client keeps the
  // body it refused as the error's cause; what reaches the log must not.
  describe('what a provider failure logs', () => {
    const SECRET = 'leaked-provider-token'
    let logs: ReturnType<typeof captureLogsForTests>
    beforeEach(() => {
      logs = captureLogsForTests('warning')
    })
    afterEach(() => logs.restore())
    const logged = () => JSON.stringify(logs.records.filter((r) => r.scope === 'sign-in'))

    it('keeps the tokens of a refused token response out of the log', async () => {
      const refusing: CustomFetch = async (url, init) => {
        if (!String(url).endsWith('/token')) return idp.fetch(url, init)
        return new Response(
          JSON.stringify({
            error: 'invalid_grant',
            id_token: SECRET,
            access_token: SECRET,
            refresh_token: SECRET,
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      const { app } = appFor({ createAccounts: true }, refusing)
      idp.next({ sub: 'ada-1' })
      const res = await signInThrough(app)
      expect(res.headers.get('location')).toBe('/sign-in?error=provider_refused')
      expect(logged()).toContain('the provider answer failed a check')
      expect(logged()).not.toContain(SECRET)
    })

    it('keeps what an unreachable provider failed with out of the log', async () => {
      const failing: CustomFetch = () =>
        Promise.reject(Object.assign(new TypeError('fetch failed'), { body: { id_token: SECRET } }))
      const { app } = appFor({ createAccounts: true }, failing)
      await app.request(`${BASE}/auth/sign-in/corp`)
      expect(logged()).toContain('the provider could not be reached')
      expect(logged()).not.toContain(SECRET)
    })
  })

  it('returns to the sign-in screen when the provider cannot be reached', async () => {
    const { app } = appFor({ createAccounts: true }, () =>
      Promise.reject(new TypeError('fetch failed')),
    )
    const res = await app.request(`${BASE}/auth/sign-in/corp`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/sign-in?error=provider_unreachable')
  })

  it.each([
    '/auth/sign-in/nobody',
    '/auth/callback/nobody?code=x&state=y',
  ])('returns an unknown provider at %s to the sign-in screen', async (path) => {
    const { app } = appFor({})
    const res = await app.request(`${BASE}${path}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/sign-in?error=unknown_provider')
  })

  // Every refusal the web app has copy for must be one the keeper can send:
  // a member nothing produces is a contract only one side honours.
  it('produces every declared sign-in refusal somewhere in the keeper', () => {
    const producers = [
      new URL('./sign-in.ts', import.meta.url),
      new URL('../security/complete-sign-in.ts', import.meta.url),
      new URL('../security/sign-in-admission.ts', import.meta.url),
    ].map((url) => readFileSync(url, 'utf8'))
    const produced = new Set(
      producers.flatMap((source) =>
        [...source.matchAll(/\b(?:refusedTo\(c, |refuse\()'([a-z_]+)'/g)].map((m) => m[1]),
      ),
    )
    expect(produced.size).toBeGreaterThan(10)
    const unproduced = signInRefusalSchema.options.filter((reason) => !produced.has(reason))
    expect(unproduced).toEqual([])
  })

  // A browser signing in anew, as itself or as somebody else, leaves nothing
  // behind that the cookie it is about to overwrite could still open.
  it('ends the session the browser held before signing in again', async () => {
    const { app, signIn } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' })
    const before = cookieFrom(await signInThrough(app), SESSION_COOKIE) as string
    idp.next({ sub: 'bob-1' })
    const started = await app.request(`${BASE}/auth/sign-in/corp`)
    const binding = cookieFrom(started, '__Host-wb_signin')
    const res = await app.request(idp.authorize(started.headers.get('location') as string), {
      headers: { cookie: `__Host-wb_signin=${binding}; ${SESSION_COOKIE}=${before}` },
    })
    const after = cookieFrom(res, SESSION_COOKIE) as string
    expect(after).toBeTruthy()
    expect(await signIn.sessions.resolve(before, Date.now())).toBeNull()
    expect(await signIn.sessions.resolve(after, Date.now())).toMatchObject({ subject: 'bob-1' })
  })

  it('ends the session on sign-out', async () => {
    const { app, signIn } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' })
    const session = cookieFrom(await signInThrough(app), SESSION_COOKIE) as string
    const res = await app.request(`${BASE}/auth/sign-out`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: BASE },
    })
    expect(res.status).toBe(204)
    expect(await signIn.sessions.resolve(session, Date.now())).toBeNull()
  })

  // The cookie rides along on a POST any page makes to this host, a sibling
  // subdomain's included, so only this host's own pages may end the session.
  it.for([
    ['no Origin', {}],
    ['a sibling origin', { origin: 'https://evil.board.example' }],
  ])('keeps the session when sign-out arrives with %s', async ([, extra]) => {
    const { app, signIn } = appFor({ createAccounts: true })
    idp.next({ sub: 'ada-1' })
    const session = cookieFrom(await signInThrough(app), SESSION_COOKIE) as string
    const res = await app.request(`${BASE}/auth/sign-out`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${session}`, ...(extra as object) },
    })
    expect(res.status).toBe(403)
    expect(res.headers.getSetCookie()).toEqual([])
    expect(await signIn.sessions.resolve(session, Date.now())).not.toBeNull()
  })
})
