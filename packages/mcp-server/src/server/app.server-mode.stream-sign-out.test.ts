/**
 * A sync stream opened on a sign-in session ends when that session does —
 * signed out, or replaced by a new sign-in in the same browser. The
 * membership re-check before each broadcast cannot see a session end (the
 * person is still a member), so a stream outliving its session would keep
 * delivering every subscribed document until the session's original expiry.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOidcProvider } from '../shared/test-utils/fake-oidc-provider.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { IDP, PUBLIC_URL, serverModePeople, serverModeSignIn } from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { DENY_ALL_STRATEGY, oidcProviders, resolvedForTest } from './security/_test-helpers.js'
import { createRelyingParty } from './security/oidc-relying-party.js'
import { signInConfigSchema } from './security/sign-in-config.js'
import { SESSION_COOKIE } from './security/sign-in-session-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from './store/db/test-helpers.js'
import {
  openSyncStreamCount,
  resetSyncStreamsForTests,
  sseBroadcastWorkspaceUpdate,
} from './sync-streams.js'

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

let handle: IsolatedDbHandle
let app: ReturnType<typeof createApp>
let idp: Awaited<ReturnType<typeof fakeOidcProvider>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-stream-sign-out-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  idp = await fakeOidcProvider(IDP, 'wb')
  const base = serverModeSignIn(handle.db, createRelyingParty({ fetch: idp.fetch }))
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
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
    authStrategy: DENY_ALL_STRATEGY,
    people: serverModePeople(handle.db, tempDir).people,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
    signIn: { ...base, providers: [resolvedForTest(open)] },
  }
  app = createApp(options)
})
afterEach(async () => {
  resetSyncStreamsForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function cookieValue(res: Response, name: string): string {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  if (line === undefined) throw new Error(`no Set-Cookie for ${name}`)
  return line.slice(name.length + 1).split(';')[0] ?? ''
}

/** Signs `sub` in through the provider, carrying `cookie` (a session this browser holds). */
async function signIn(sub: string, cookie?: string): Promise<string> {
  idp.next({ sub, name: sub })
  const started = await app.request(`${PUBLIC_URL}/auth/sign-in/corp`)
  const attempt = cookieValue(started, ATTEMPT_COOKIE)
  const callback = idp.authorize(started.headers.get('location') as string)
  const done = await app.request(callback, {
    headers: { cookie: [`${ATTEMPT_COOKIE}=${attempt}`, cookie].filter(Boolean).join('; ') },
  })
  expect(done.status).toBe(302)
  return `${SESSION_COOKIE}=${cookieValue(done, SESSION_COOKIE)}`
}

const asPage = (cookie: string) => ({ cookie, origin: PUBLIC_URL })

async function workspaceOf(cookie: string): Promise<string> {
  const created = await app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...asPage(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Plans' }),
  })
  expect(created.status).toBe(201)
  return ((await created.json()) as { workspaceId: string }).workspaceId
}

async function followed(cookie: string, workspaceId: string) {
  const res = await app.request(`${PUBLIC_URL}/api/sync/stream`, { headers: asPage(cookie) })
  expect(res.status).toBe(200)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const ready = new TextDecoder().decode((await reader.read()).value)
  const { streamId } = JSON.parse(ready.split('data:')[1] ?? '{}') as { streamId: string }
  const subscribed = await app.request(`${PUBLIC_URL}/api/sync/subscribe`, {
    method: 'POST',
    headers: { ...asPage(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ streamId, subscribe: [`workspace:${workspaceId}`] }),
  })
  expect(subscribed.status).toBe(200)
  return reader
}

async function next(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const read = await reader.read()
  return read.done ? 'closed' : new TextDecoder().decode(read.value)
}

describe('server mode — a sync stream ends with the session that opened it', () => {
  it('ends the stream of a session signed out, and only that session’s', async () => {
    const leaving = await signIn('ada')
    const staying = await signIn('ada')
    const workspaceId = await workspaceOf(leaving)
    const ended = await followed(leaving, workspaceId)
    const other = await followed(staying, workspaceId)

    const out = await app.request(`${PUBLIC_URL}/auth/sign-out`, {
      method: 'POST',
      headers: asPage(leaving),
    })
    expect(out.status).toBe(204)
    sseBroadcastWorkspaceUpdate(workspaceId, new Uint8Array([1, 2, 3]))

    expect(await next(ended)).toBe('closed')
    expect(await next(other)).toMatch(/^event: update/)
    expect(openSyncStreamCount()).toBe(1)
  })

  it('ends the stream of the session a new sign-in in the same browser replaces', async () => {
    const first = await signIn('ada')
    const workspaceId = await workspaceOf(first)
    const reader = await followed(first, workspaceId)

    await signIn('ada', first)
    sseBroadcastWorkspaceUpdate(workspaceId, new Uint8Array([1, 2, 3]))

    expect(await next(reader)).toBe('closed')
    expect(openSyncStreamCount()).toBe(0)
  })
})
