/**
 * Server mode's `/api/runtime/status` and `/api/runtime/storage` describe the
 * whole instance — every workspace's bytes, every user's open sync streams,
 * the process id — so on a shared server they answer a tenant administrator
 * and nobody else. Any signed-in person holds `runtime:read` (the font
 * catalogue sits on it), so the scope alone cannot be the bar.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeStatusResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import {
  bearerNamesItsSubject,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { testDataLayout } from './routes/_test-helpers.js'
import type { MemberProfileStore } from './security/member-profile-store.js'
import { SESSION_COOKIE, type SignInSessionStore } from './security/sign-in-session-store.js'
import { createTenantAdministratorStore } from './security/tenant-administrator-store.js'
import { createIsolatedDb } from './store/db/test-helpers.js'

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

const STATUS: RuntimeStatusResponse = {
  ok: true,
  pid: 4242,
  version: '0.0.0',
  startedAt: '2024-01-01T00:00:00.000Z',
  uptimeMs: 0,
  idleForMs: 0,
  auth: { mode: 'oauth', hasToken: false },
  storage: { dataDir: '/srv/whiteboard', dataDirWritable: true },
  mcp: { httpEnabled: true },
  clients: { connected: 7, ready: 5 },
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-runtime-admin-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  members = stores.members
  sessions = stores.sessions
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
    people: stores.people,
    touch: () => {},
    getStatus: () => STATUS,
  }
  app = createApp(options)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

async function signedIn(subject: string): Promise<Record<string, string>> {
  const binding = { authenticator: ISSUER, subject }
  await members.ensureProfile({ binding, displayName: subject })
  const token = await sessions.create(binding, Date.now(), 60_000, Date.now())
  return { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL }
}

async function appointed(subject: string): Promise<void> {
  const user = await members.profileForBinding({ authenticator: ISSUER, subject })
  if (user === null) throw new Error(`no user for ${subject}`)
  await createTenantAdministratorStore(handle.db).appoint(user.id, null)
}

const get = (path: string, headers: Record<string, string>) =>
  app.request(`${PUBLIC_URL}${path}`, { headers })

describe('server mode runtime routes answer administrators only', () => {
  it('refuses a signed-in member status and storage', async () => {
    const bob = await signedIn('bob')
    const status = await get('/api/runtime/status', bob)
    expect(status.status).toBe(403)
    expect(await status.text()).not.toContain('"clients"')
    expect((await get('/api/runtime/storage', bob)).status).toBe(403)
  })

  it('refuses a member bearer status and storage', async () => {
    await members.ensureProfile({
      binding: { authenticator: ISSUER, subject: 'carol' },
      displayName: 'carol',
    })
    const carol = { authorization: 'Bearer carol' }
    expect((await get('/api/runtime/status', carol)).status).toBe(403)
    expect((await get('/api/runtime/storage', carol)).status).toBe(403)
  })

  it('answers an appointed administrator both', async () => {
    const ada = await signedIn('ada')
    await appointed('ada')
    const status = await get('/api/runtime/status', ada)
    expect(status.status).toBe(200)
    expect(((await status.json()) as RuntimeStatusResponse).clients).toEqual(STATUS.clients)
    expect((await get('/api/runtime/storage', ada)).status).toBe(200)
  })

  it('still lets a member read the font catalogue on the same scope', async () => {
    const bob = await signedIn('bob')
    expect((await get('/api/fonts', bob)).status).toBe(200)
  })

  it('keeps ping public', async () => {
    expect((await app.request(`${PUBLIC_URL}/api/runtime/ping`)).status).toBe(200)
  })
})
