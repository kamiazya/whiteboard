/**
 * A sync stream lives no longer than the grant that opened it. The membership
 * re-check before each broadcast cannot see an expiry — the person is still a
 * member — so a stream opened on a session or bearer about to expire would
 * otherwise keep delivering after every request on that grant is refused.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { ISSUER, PUBLIC_URL, serverModePeople } from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { ALL_AUTH_SCOPES } from './security/auth-strategy.js'
import type { MemberProfileStore } from './security/member-profile-store.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import { SESSION_COOKIE, type SignInSessionStore } from './security/sign-in-session-store.js'
import { createIsolatedDb } from './store/db/test-helpers.js'
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

// "Bearer <sub> <expiresAt>": a verified bearer naming that subject and
// expiring at that epoch millisecond. The strategy does not itself refuse an
// expired one, so every request here gets through and only the stream's own
// bound can end it.
const bearerExpiringAt: AsyncAuthStrategy = {
  async authorize({ authorizationHeader }) {
    const [sub = '', at = ''] = (authorizationHeader ?? '').replace(/^Bearer /, '').split(' ')
    return {
      ok: true,
      context: { kind: 'oauth-resource-server', subject: sub, scopes: ALL_AUTH_SCOPES },
      person: { authenticator: ISSUER, subject: sub },
      expiresAt: Number(at),
    }
  },
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-stream-expiry-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  members = stores.members
  sessions = stores.sessions
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerExpiringAt,
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
    people: stores.people,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
})
afterEach(async () => {
  resetSyncStreamsForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

async function signedIn(subject: string, ttlMs: number): Promise<Record<string, string>> {
  const binding = { authenticator: ISSUER, subject }
  await members.ensureProfile({ binding, displayName: subject })
  const token = await sessions.create(binding, Date.now(), ttlMs, Date.now())
  return { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL }
}

async function opened(headers: Record<string, string>) {
  const res = await app.request(`${PUBLIC_URL}/api/sync/stream`, { headers })
  expect(res.status).toBe(200)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const ready = new TextDecoder().decode((await reader.read()).value)
  const { streamId } = JSON.parse(ready.split('data:')[1] ?? '{}') as { streamId: string }
  return { reader, streamId }
}

async function followed(headers: Record<string, string>, workspaceId: string) {
  const { reader, streamId } = await opened(headers)
  const res = await app.request(`${PUBLIC_URL}/api/sync/subscribe`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ streamId, subscribe: [`workspace:${workspaceId}`] }),
  })
  expect(res.status).toBe(200)
  return reader
}

async function next(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const read = await reader.read()
  return read.done ? 'closed' : new TextDecoder().decode(read.value)
}

describe('server mode — a sync stream ends when its grant expires', () => {
  it('ends a stream opened on a sign-in session once the session expires', async () => {
    const ada = await signedIn('ada', 1_000)
    const { reader } = await opened(ada)

    expect(await next(reader)).toBe('closed')
    expect(openSyncStreamCount()).toBe(0)
  })

  it('ends a bearer’s stream at its expiry and delivers nothing more down it', async () => {
    const owner = await signedIn('ada', 60_000)
    const created = await app.request(`${PUBLIC_URL}/api/workspaces`, {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Plans' }),
    })
    const { workspaceId } = (await created.json()) as { workspaceId: string }
    const lasting = await followed(
      { authorization: `Bearer ada ${Date.now() + 600_000}` },
      workspaceId,
    )
    const expiring = await followed(
      { authorization: `Bearer ada ${Date.now() + 500}` },
      workspaceId,
    )

    expect(await next(expiring)).toBe('closed')
    sseBroadcastWorkspaceUpdate(workspaceId, new Uint8Array([1, 2, 3]))

    // The bound is the grant's, not the person's: their other stream stays.
    expect(await next(lasting)).toMatch(/^event: update/)
    expect(openSyncStreamCount()).toBe(1)
  })
})
