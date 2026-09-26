/**
 * ADR-0046 decision 2, through the routes: a reverse proxy in front of the
 * keeper has signed the person in, and the keeper opens its own session on
 * the proxy's word — only from the proxy's address, only for the browser
 * that began the attempt, and through the same admission as OIDC.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdministratorCheck } from '../security/administrator-check.js'
import { createCompleteSignInDeps } from '../security/complete-sign-in.js'
import { createRelyingParty } from '../security/oidc-relying-party.js'
import { createSignInAttemptStore } from '../security/sign-in-attempt-store.js'
import { providerAuthenticator, signInConfigSchema } from '../security/sign-in-config.js'
import { SESSION_COOKIE } from '../security/sign-in-session-store.js'
import { createTenantAdministratorStore } from '../security/tenant-administrator-store.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createSignInRoutes, type SignInRouteProvider } from './sign-in.js'

const BASE = 'https://board.example'
const HOUR = 60 * 60 * 1000
const PROXY_ADDRESS = '10.0.0.7'

function proxyProvider(admission: object, trustedAddresses: string[]): SignInRouteProvider {
  const [provider] = signInConfigSchema.parse({
    providers: [
      {
        id: 'corp-proxy',
        kind: 'trusted-header',
        displayName: 'Corp SSO',
        trustedAddresses,
        identity: { subjectHeader: 'X-Forwarded-User', nameHeader: 'X-Forwarded-Name' },
        admission,
      },
    ],
  }).providers
  if (provider?.kind !== 'trusted-header') throw new Error('expected a proxy provider')
  return provider
}

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
/** The peer the next request arrives from, as the socket would report it. */
let peer: string | undefined

function appFor(admission: object, trustedAddresses = [PROXY_ADDRESS], injectPeer = true) {
  const signIn = createCompleteSignInDeps(handle.db, HOUR)
  const provider = proxyProvider(admission, trustedAddresses)
  const app = new Hono()
  app.route(
    '/',
    createSignInRoutes({
      providers: [provider],
      rp: createRelyingParty(),
      attempts: createSignInAttemptStore(handle.db),
      signIn,
      administrators: createAdministratorCheck({
        admins: createTenantAdministratorStore(handle.db),
        members: signIn.members,
        configured: [],
      }),
      publicBaseUrl: BASE,
      ...(injectPeer ? { peerAddress: () => peer } : {}),
    }),
  )
  return { app, signIn, provider }
}

function cookieFrom(res: Response, name: string): string | undefined {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  return header?.slice(name.length + 1).split(';')[0]
}

/** Begin, then follow the redirect to the callback with the given headers. */
async function signInThrough(app: Hono, headers: Record<string, string>, query = '') {
  peer = PROXY_ADDRESS
  const started = await app.request(`${BASE}/auth/sign-in/corp-proxy${query}`)
  const binding = cookieFrom(started, '__Host-wb_signin')
  return app.request(started.headers.get('location') as string, {
    headers: { ...headers, cookie: `__Host-wb_signin=${binding}` },
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-sign-in-proxy-'))
  handle = await createIsolatedDb({ dataDir: root })
  peer = undefined
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('sign-in through a trusted reverse proxy', () => {
  it('sends the browser to its own callback, bound to this browser, not to a provider', async () => {
    const { app } = appFor({ createAccounts: true })
    peer = PROXY_ADDRESS
    const res = await app.request(`${BASE}/auth/sign-in/corp-proxy`)
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location') as string)
    expect(to.origin + to.pathname).toBe(`${BASE}/auth/callback/corp-proxy`)
    expect(to.searchParams.get('state')).toBeTruthy()
    expect(cookieFrom(res, '__Host-wb_signin')).toBeTruthy()
  })

  it('opens a session for the person the proxy names', async () => {
    const { app, signIn, provider } = appFor({ createAccounts: true })
    const res = await signInThrough(
      app,
      { 'X-Forwarded-User': 'ada', 'X-Forwarded-Name': 'Ada' },
      '?return=%2Fw%2Fplans',
    )
    expect(res.headers.get('location')).toBe('/w/plans')
    const session = cookieFrom(res, SESSION_COOKIE)
    const person = await signIn.sessions.resolve(session as string, Date.now())
    expect(person).toEqual({
      authenticator: providerAuthenticator(provider as never),
      subject: 'ada',
    })
    expect((await signIn.members.profileForBinding(person as never))?.displayName).toBe('Ada')
  })

  // ADR-0051: a proxy cannot be asked to sign someone in again, so a proxy
  // session is not sent anywhere to re-authenticate — and says no time.
  it('refuses to re-authenticate a session the proxy opened', async () => {
    const { app, signIn } = appFor({ createAccounts: true })
    const res = await signInThrough(app, { 'X-Forwarded-User': 'ada' })
    const session = cookieFrom(res, SESSION_COOKIE) as string
    expect((await signIn.sessions.open(session, Date.now()))?.authenticatedAt).toBeNull()
    const again = await app.request(`${BASE}/auth/reauthenticate`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    })
    expect(again.headers.get('location')).toBe('/sign-in?error=reauthentication_unavailable')
  })

  // The header is whatever the caller typed unless the proxy set it.
  it('refuses the identity header from any other address', async () => {
    const { app } = appFor({ createAccounts: true })
    peer = PROXY_ADDRESS
    const started = await app.request(`${BASE}/auth/sign-in/corp-proxy`)
    const binding = cookieFrom(started, '__Host-wb_signin')
    peer = '203.0.113.9'
    const res = await app.request(started.headers.get('location') as string, {
      headers: { 'X-Forwarded-User': 'ada', cookie: `__Host-wb_signin=${binding}` },
    })
    expect(res.headers.get('location')).toBe('/sign-in?error=provider_refused')
    expect(cookieFrom(res, SESSION_COOKIE)).toBeUndefined()
  })

  it('refuses a callback from a browser that did not begin the attempt', async () => {
    const { app } = appFor({ createAccounts: true })
    peer = PROXY_ADDRESS
    const started = await app.request(`${BASE}/auth/sign-in/corp-proxy`)
    const res = await app.request(started.headers.get('location') as string, {
      headers: { 'X-Forwarded-User': 'ada', cookie: '__Host-wb_signin=someone-else' },
    })
    expect(res.headers.get('location')).toBe('/sign-in?error=sign_in_attempt_unknown')
    expect(cookieFrom(res, SESSION_COOKIE)).toBeUndefined()
  })

  it('refuses a request the proxy sent without naming anyone', async () => {
    const { app } = appFor({ createAccounts: true })
    const res = await signInThrough(app, {})
    expect(res.headers.get('location')).toBe('/sign-in?error=provider_refused')
  })

  // Decision 4 holds for the proxy as for OIDC: invitation-only by default.
  it('refuses an uninvited person when the provider does not create accounts', async () => {
    const { app } = appFor({})
    const res = await signInThrough(app, { 'X-Forwarded-User': 'ada' })
    expect(res.headers.get('location')).toBe('/sign-in?error=not_invited')
  })

  it('is listed for the sign-in screen by its display name', async () => {
    const { app } = appFor({})
    const res = await app.request(`${BASE}/auth/providers`)
    expect(await res.json()).toEqual({ providers: [{ id: 'corp-proxy', displayName: 'Corp SSO' }] })
  })
})

// The routes above are handed the peer; this is the server reading it off
// the socket, which is the whole of the check in production.
describe('the peer address, read from a real socket', () => {
  async function signInOverSocket(trustedAddresses: string[]) {
    const { app } = appFor({ createAccounts: true }, trustedAddresses, false)
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise((resolve) => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const started = await fetch(`${origin}/auth/sign-in/corp-proxy`, { redirect: 'manual' })
      const binding = cookieFrom(started, '__Host-wb_signin')
      const callback = (started.headers.get('location') as string).replace(BASE, origin)
      return await fetch(callback, {
        redirect: 'manual',
        headers: { 'X-Forwarded-User': 'ada', cookie: `__Host-wb_signin=${binding}` },
      })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }

  it('honours the proxy connecting from a trusted address', async () => {
    const res = await signInOverSocket(['127.0.0.1'])
    expect(cookieFrom(res, SESSION_COOKIE)).toBeTruthy()
  })

  it('refuses the same request from an address the list does not hold', async () => {
    const res = await signInOverSocket(['10.0.0.1'])
    expect(res.headers.get('location')).toBe('/sign-in?error=provider_refused')
  })
})
