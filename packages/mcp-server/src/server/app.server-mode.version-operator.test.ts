/**
 * Through server mode's whole `/api`: a row a person writes names the member
 * who wrote it. A saved version or a promote checkpoint carries the caller's
 * own profile name — never a name the request states, and never the server
 * process's OS account.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bearerNamesItsSubject,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { resolveTestServerDeps, testDataLayout } from './routes/_test-helpers.js'
import type { MemberProfileStore } from './security/member-profile-store.js'
import { SESSION_COOKIE, type SignInSessionStore } from './security/sign-in-session-store.js'
import { createIsolatedDb } from './store/db/test-helpers.js'
import { resetSyncStreamsForTests } from './sync-streams.js'

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

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let serverDeps: ServerDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-version-operator-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  members = stores.members
  sessions = stores.sessions
  serverDeps = await resolveTestServerDeps(tempDir)
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps,
    dataLayout: testDataLayout(tempDir),
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

type Headers = Record<string, string>
const json = { 'content-type': 'application/json' }

async function signedIn(subject: string, displayName: string): Promise<Headers> {
  const binding = { authenticator: ISSUER, subject }
  await members.ensureProfile({ binding, displayName })
  const token = await sessions.create(binding, Date.now(), 60_000, Date.now())
  return { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL }
}

async function createWorkspace(headers: Headers): Promise<string> {
  const res = await app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...headers, ...json },
    body: JSON.stringify({ displayName: 'Design' }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { workspaceId: string }).workspaceId
}

type Operator = Record<string, unknown> | undefined

describe('server mode — a version row names the member who saved it', () => {
  it('stamps the caller’s profile name over a stated operator', async () => {
    const ada = await signedIn('ada-sub', 'Ada Lovelace')
    const workspaceId = await createWorkspace(ada)
    await serverDeps.documentIndex.createDocument({ workspaceId, path: 'plan', kind: 'markdown' })

    const res = await app.request(
      `${PUBLIC_URL}/api/workspaces/${workspaceId}/documents/plan/versions`,
      {
        method: 'POST',
        headers: { ...ada, ...json },
        body: JSON.stringify({ operator: { kind: 'ai', displayName: 'Eve', agentId: 'a-1' } }),
      },
    )

    expect(res.status).toBe(200)
    const operator = ((await res.json()) as { version: { operator?: Operator } }).version.operator
    expect(operator?.kind).toBe('human')
    expect(operator?.displayName).toBe('Ada Lovelace')
    expect(operator).not.toHaveProperty('agentId')
  })

  it('stamps the caller’s profile name on a promote checkpoint', async () => {
    const ada = await signedIn('ada-sub', 'Ada Lovelace')
    const workspaceId = await createWorkspace(ada)
    const record = new LoroDoc()
    createWorkspaceDocumentAtPath(record, {
      path: 'sketch',
      documentId: '01BRWAAAAAAAAAAAAAAAAAAAA1',
      kind: 'spatial',
    })
    record.commit()

    const res = await app.request(`${PUBLIC_URL}/api/w/${workspaceId}/workspace-document/promote`, {
      method: 'POST',
      headers: { ...ada, ...json },
      body: JSON.stringify({
        snapshot: Buffer.from(record.export({ mode: 'snapshot' })).toString('base64url'),
      }),
    })
    expect(res.status).toBe(200)

    const listed = await app.request(
      `${PUBLIC_URL}/api/workspaces/${workspaceId}/documents/sketch/versions`,
      { headers: ada },
    )
    const { versions } = (await listed.json()) as { versions: { operator?: Operator }[] }
    expect(versions).toHaveLength(1)
    expect(versions[0]?.operator?.displayName).toBe('Ada Lovelace')
  })
})
