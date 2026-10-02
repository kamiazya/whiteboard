/**
 * The attributes of the two cookies sign-in sets, through server mode's whole
 * app. The session cookie is a hosted user's only credential, so each
 * attribute is a property of the credential: script cannot read it (HttpOnly),
 * a plaintext hop does not carry it (Secure), a cross-site request does not
 * attach it (SameSite), it is scoped to the host's every path, it lives as long
 * as the session does, and signing out really expires it. None of this shows
 * in a test that reads only a cookie's value.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOidcProvider } from '../shared/test-utils/fake-oidc-provider.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { IDP, PUBLIC_URL, serverModeSignIn } from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { DENY_ALL_STRATEGY, oidcProviders, resolvedForTest } from './security/_test-helpers.js'
import { createRelyingParty } from './security/oidc-relying-party.js'
import { signInConfigSchema } from './security/sign-in-config.js'
import { SESSION_COOKIE } from './security/sign-in-session-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from './store/db/test-helpers.js'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('./app.js')
const { createContainer, resolveServerDeps } = await import('../di/container.js')

const ATTEMPT_COOKIE = '__Host-wb_signin'
const NOW = Date.UTC(2030, 0, 1)

let handle: IsolatedDbHandle
let app: ReturnType<typeof createApp>
let idp: Awaited<ReturnType<typeof fakeOidcProvider>>
let sessionTtlMs: number

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-sign-in-cookies-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  idp = await fakeOidcProvider(IDP, 'wb')
  const base = serverModeSignIn(handle.db, createRelyingParty({ fetch: idp.fetch }))
  // The shared harness's provider admits nobody uninvited; this one creates
  // the account, so the callback reaches the point that sets the session.
  const [open] = oidcProviders(
    signInConfigSchema.parse({
      providers: [
        {
          id: 'corp',
          kind: 'oidc',
          issuer: IDP,
          clientId: 'wb',
          clientSecret: { env: 'CORP_SECRET' },
          admission: { createAccounts: true },
        },
      ],
    }).providers,
  )
  if (open === undefined) throw new Error('unreachable')
  sessionTtlMs = base.signIn.sessionTtlMs
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
    authStrategy: DENY_ALL_STRATEGY,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
    signIn: { ...base, providers: [resolvedForTest(open)], now: () => NOW },
  }
  app = createApp(options)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** The attributes of one `Set-Cookie`, lower-cased and split, name first. */
function setCookie(res: Response, name: string): string[] {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  if (line === undefined) throw new Error(`no Set-Cookie for ${name}`)
  return line.split(';').map((part) => part.trim())
}

const attribute = (parts: readonly string[], key: string): string | undefined =>
  parts.find((p) => p.toLowerCase().startsWith(`${key.toLowerCase()}=`))?.split('=')[1]

const flag = (parts: readonly string[], key: string): boolean =>
  parts.some((p) => p.toLowerCase() === key.toLowerCase())

/** Every attribute that makes a cookie host-only, script-proof and same-site. */
function expectHostOnlyCredentialAttributes(parts: readonly string[]) {
  expect(flag(parts, 'HttpOnly')).toBe(true)
  expect(flag(parts, 'Secure')).toBe(true)
  expect(attribute(parts, 'SameSite')?.toLowerCase()).toBe('lax')
  expect(attribute(parts, 'Path')).toBe('/')
  expect(attribute(parts, 'Domain')).toBeUndefined()
}

describe('server mode — the sign-in cookies', () => {
  it('sets the attempt cookie host-only and script-proof, living as long as the attempt does', async () => {
    const res = await app.request(`${PUBLIC_URL}/auth/sign-in/corp`)
    expect(res.status).toBe(302)

    const parts = setCookie(res, ATTEMPT_COOKIE)
    expectHostOnlyCredentialAttributes(parts)
    // The cookie must not outlive the row it unlocks: the attempt's own
    // expiry, as the store recorded it, is the lifetime.
    const [attempt, ...more] = await handle.db.selectFrom('signInAttempts').selectAll().execute()
    expect(more).toEqual([])
    expect(attribute(parts, 'Max-Age')).toBe(String((Number(attempt?.expiresAt) - NOW) / 1000))
  })

  it('sets the session cookie host-only and script-proof, living as long as the session does', async () => {
    idp.next({ sub: 'ada-1', name: 'Ada' })
    const started = await app.request(`${PUBLIC_URL}/auth/sign-in/corp`)
    const binding = setCookie(started, ATTEMPT_COOKIE)[0]?.slice(ATTEMPT_COOKIE.length + 1)
    const callback = idp.authorize(started.headers.get('location') as string)
    const done = await app.request(callback, {
      headers: { cookie: `${ATTEMPT_COOKIE}=${binding}` },
    })
    expect(done.status).toBe(302)

    const parts = setCookie(done, SESSION_COOKIE)
    expectHostOnlyCredentialAttributes(parts)
    expect(attribute(parts, 'Max-Age')).toBe(String(sessionTtlMs / 1000))
    // The attempt cookie is spent by the callback and says so.
    const spent = setCookie(done, ATTEMPT_COOKIE)
    expect(attribute(spent, 'Max-Age')).toBe('0')
  })

  it('expires the session cookie when signing out', async () => {
    const res = await app.request(`${PUBLIC_URL}/auth/sign-out`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=whatever`, origin: PUBLIC_URL },
    })
    expect(res.status).toBe(204)
    const parts = setCookie(res, SESSION_COOKIE)
    expect(attribute(parts, 'Max-Age')).toBe('0')
    expect(parts[0]).toBe(`${SESSION_COOKIE}=`)
    expectHostOnlyCredentialAttributes(parts)
  })
})
