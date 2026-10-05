// @vitest-environment node
/**
 * Every route that takes a request body refuses an oversized one with 413
 * `payload_too_large`, whichever surface serves it. A route nobody capped
 * buffered whatever it was sent before it looked at it, and stored what it
 * carried (a megabyte label, a 17 MiB path).
 *
 * The routes are read off the registered surface rather than listed here, so a
 * write added tomorrow is held to the same answer or fails this file by name.
 * A route that reads no body is named in `READS_NO_BODY` with why; a route that
 * legitimately takes more than a few fields is named in `TAKES_CONTENT`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { storeMemoryModule } from '../../shared/test-utils/store-memory.module.js'
import { registeredKeys } from '../_test-route-fuzz-lane.js'
import {
  bearerNamesItsSubject,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from '../_test-server-mode-harness.js'
import { SESSION_COOKIE } from '../security/sign-in-session-store.js'
import { createTenantAdministratorStore } from '../security/tenant-administrator-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../store/db/test-helpers.js'
import { testDataLayout } from './_test-helpers.js'

let dataDir = ''
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('../app.js')

const TOKEN = 'json-body-ceiling-token'
const WORKSPACE = 'ws-known'
const MIB = 1024 * 1024
/** Spelled here, not imported: the ceiling under test cannot also be the oracle for it. */
const A_MEGABYTE_AND_ONE = MIB + 1
/** Past the largest ceiling any route holds (workspace promotion's), so no route's own limit excuses it. */
const OVER_EVERY_CEILING = 25 * MIB

const WRITES = new Set(['POST', 'PUT', 'PATCH'])

/** Writes that answer without reading a body, each with why. */
const READS_NO_BODY: Readonly<Record<string, string>> = {
  'POST /api/people/:userId/deactivation': 'the URL names the person',
  'PUT /api/people/:userId/administrator': 'the URL names the person',
  'POST /api/workspaces/:workspace/invitations':
    'an invitation is minted from who asked, not from a body',
  'POST /api/invitations': 'a tenant invitation is minted from who asked, not from a body',
  'POST /api/fonts/:id/install': 'installs a catalogued font by id; the request carries nothing',
  'POST /api/workspaces/:workspaceId/documents/optimize-all': 'a maintenance action, no options',
  'POST /api/workspaces/:workspaceId/files/purge-dangling': 'a maintenance action, no options',
  'POST /api/workspaces/:workspaceId/documents/*/duplicate':
    'the URL names the source; the keeper derives the rest',
  'POST /api/workspaces/:workspaceId/trash/:documentId/restore': 'the URL names the document',
  'POST /api/workspaces/:workspaceId/versions/prune-sandwiched': 'a maintenance action, no options',
}

/** Writes whose body is content or a snapshot rather than fields, so a megabyte is not too much for them. */
const TAKES_CONTENT: Readonly<Record<string, string>> = {
  'POST /api/v1/workspaces/:workspaceId/documents': 'a markdown document created from its content',
  'POST /api/w/:workspaceId/document/*/update': 'a Loro update for a document',
  'POST /api/w/:workspaceId/workspace-document/update': "a Loro update for a workspace's record",
  'POST /api/w/:workspaceId/workspace-document/promote': "a workspace's whole record, base64url",
  'PUT /api/w/:workspaceId/document/*/file/:fileId': 'an uploaded file',
}

type App = ReturnType<typeof createApp>
interface Composition {
  readonly app: App
  readonly headers: Record<string, string>
  readonly base: string
  /** A workspace the caller holds, so a membership check does not refuse before the body is read. */
  readonly workspace: string
}

let handle: IsolatedDbHandle | undefined
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-json-body-ceiling-'))
})
afterEach(async () => {
  await handle?.dispose()
  handle = undefined
  await rm(dataDir, { recursive: true, force: true })
})

async function localDaemon(): Promise<Composition> {
  const serverDeps = resolveServerDeps(createContainer(storeMemoryModule))
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WORKSPACE })
  const app = createApp({
    authMode: 'local-daemon',
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({}) as never,
    serverDeps,
    dataLayout: testDataLayout(),
  })
  return { app, headers: { Authorization: `Bearer ${TOKEN}` }, base: '', workspace: WORKSPACE }
}

/** An administrator signed in just now, who holds a workspace of their own. */
async function serverMode(): Promise<Composition> {
  handle = await createIsolatedDb({ dataDir })
  const stores = serverModePeople(handle.db, dataDir)
  const app = createApp({
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
    people: stores.people,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  })
  const binding = { authenticator: ISSUER, subject: 'ada' }
  const profile = await stores.members.ensureProfile({ binding, displayName: 'ada' })
  await createTenantAdministratorStore(handle.db).appoint(profile.id, null)
  const token = await stores.sessions.create(binding, Date.now(), 60_000, Date.now())
  const headers = { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL }
  const created = await app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Plans' }),
  })
  const { workspaceId } = (await created.json()) as { workspaceId: string }
  return { app, headers, base: PUBLIC_URL, workspace: workspaceId }
}

/** `METHOD /pattern` for every write the app registers, `/api/v1` and wildcard actions included. */
function writeKeys(app: App): string[] {
  const v1 = app.routes
    .filter((r) => r.path.startsWith('/api/v1/') && r.method !== 'ALL')
    .map((r) => `${r.method} ${r.path}`)
  return [...new Set([...registeredKeys(app), ...v1])]
    .filter((key) => WRITES.has(key.split(' ')[0] as string))
    .sort()
}

function concretePath(pattern: string, workspace: string): string {
  return pattern
    .replace(/:(\w+)/g, (_m, name: string) => (name.startsWith('workspace') ? workspace : 'x'))
    .replace(/\*/g, 'doc')
}

async function statusOfEach(
  { app, headers, base, workspace }: Composition,
  keys: readonly string[],
  size: number,
): Promise<Record<string, number>> {
  const answers: Record<string, number> = {}
  for (const key of keys) {
    const [method, pattern] = key.split(' ') as [string, string]
    const res = await app.request(`${base}${concretePath(pattern, workspace)}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: new Uint8Array(size).fill(0x20),
    })
    answers[key] = res.status
  }
  return answers
}

const COMPOSITIONS = [
  ['the local daemon', localDaemon],
  ['server mode', serverMode],
] as const

describe.each(COMPOSITIONS)('an oversized request body on %s', (_name, compose) => {
  it('is checked against the writes the composition registers', async () => {
    const { app } = await compose()
    const keys = writeKeys(app)
    // An empty walk agrees with everything; these are what keep it honest.
    expect(keys.length).toBeGreaterThan(20)
    expect(keys).toContain('POST /api/sync/message')
    expect(keys.some((key) => key.includes('/api/v1/'))).toBe(true)
  })

  it('is 413 on every write that reads a body, whatever its own ceiling', async () => {
    const composition = await compose()
    const keys = writeKeys(composition.app).filter((key) => READS_NO_BODY[key] === undefined)

    const answers = await statusOfEach(composition, keys, OVER_EVERY_CEILING)

    expect(Object.entries(answers).filter(([, status]) => status !== 413)).toEqual([])
  }, 120_000)

  it('is 413 past a megabyte on every write that takes only fields', async () => {
    const composition = await compose()
    const keys = writeKeys(composition.app).filter(
      (key) => READS_NO_BODY[key] === undefined && TAKES_CONTENT[key] === undefined,
    )

    const answers = await statusOfEach(composition, keys, A_MEGABYTE_AND_ONE)

    expect(Object.entries(answers).filter(([, status]) => status !== 413)).toEqual([])
  }, 120_000)
})

describe('a write that takes content', () => {
  it('is not refused at the ceiling sized for fields', async () => {
    const composition = await localDaemon()
    const keys = Object.keys(TAKES_CONTENT)

    const answers = await statusOfEach(composition, keys, A_MEGABYTE_AND_ONE)

    expect(Object.entries(answers).filter(([, status]) => status === 413)).toEqual([])
  }, 60_000)
})

describe('the exemption ledgers', () => {
  it('each entry is a write one of the compositions registers', async () => {
    const registered = new Set([
      ...writeKeys((await localDaemon()).app),
      ...writeKeys((await serverMode()).app),
    ])
    const stale = Object.keys({ ...READS_NO_BODY, ...TAKES_CONTENT }).filter(
      (key) => !registered.has(key),
    )
    expect(stale).toEqual([])
  })
})
