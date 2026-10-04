// @vitest-environment node
/**
 * A workspace nothing answers to is refused in ONE voice on every legacy
 * `/api/workspaces/:workspaceId/*` route and the page-facing workspace-document
 * routes: 404 `{ error: 'workspace_not_found', message }`, the answer
 * `/api/v1` gives.
 *
 * A route that answered an unknown workspace with an empty or zero 200 (a
 * write that did nothing, or minted a name row for a workspace that does not
 * exist) or in another body family leaves a client unable to tell "gone" from
 * "empty". So every route is driven, reads and writes alike, and a workspace
 * that exists and holds nothing is held to its empty 200 beside them.
 *
 * Driven through `createApp` over the production store wiring, since the
 * refusal spans routers mounted separately (the files router answers one of
 * these and is composed beside the document router, not inside it).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { createSelfHostStoreLocalModule } from '../../di/store-local.module.js'
import { createWorkspaceReplicaKeyStore } from '../security/workspace-replica-key-store.js'
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
}))

const { createApp } = await import('../app.js')

const TOKEN = 'unknown-workspace-token'
const GONE = 'nowhere'
const KNOWN = 'ws-known'
const KNOWN_SEGMENT = 'my-segment'

let handle: IsolatedDbHandle | undefined
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-unknown-workspace-'))
})
afterEach(async () => {
  await handle?.dispose()
  handle = undefined
  await rm(dataDir, { recursive: true, force: true })
})

async function app() {
  // The isolated database is the one every store here reads, so the workspace
  // is seeded through the deps built over it rather than over a second handle.
  handle = await createIsolatedDb({ dataDir })
  const serverDeps = resolveServerDeps(
    createContainer(createSelfHostStoreLocalModule(handle.db, dataDir)),
  )
  await serverDeps.documentIndex.createWorkspace({ workspaceId: KNOWN, segment: KNOWN_SEGMENT })
  return createApp({
    authMode: 'local-daemon',
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({}) as never,
    serverDeps,
    dataLayout: testDataLayout(),
    replicaKeys: createWorkspaceReplicaKeyStore(handle.db, { defaultTier: 'offline' }),
  })
}

interface Probe {
  readonly method: string
  readonly path: (workspace: string) => string
  readonly body?: unknown
}

const probe = (method: string, suffix: string, body?: unknown): Probe => ({
  method,
  path: (workspace) => `/api/workspaces/${workspace}${suffix}`,
  ...(body === undefined ? {} : { body }),
})
const pageProbe = (method: string, suffix: string): Probe => ({
  method,
  path: (workspace) => `/api/w/${workspace}${suffix}`,
})

/** Every route that names a workspace by `:workspaceId` in the legacy surface, reads and writes alike. */
const ROUTES: readonly Probe[] = [
  probe('GET', '/names'),
  probe('PUT', '/name', { name: 'x' }),
  probe('GET', '/documents'),
  probe('GET', '/documents/some/versions'),
  probe('POST', '/documents/optimize-all'),
  probe('POST', '/versions/prune-sandwiched'),
  probe('POST', '/files/purge-dangling'),
  probe('GET', '/trash'),
  probe('POST', '/trash/d1/restore'),
  probe('DELETE', '/trash/d1'),
  probe('PATCH', '', { displayName: 'x' }),
  probe('PUT', '/documents/a/name', { name: 'x' }),
  probe('PUT', '/documents/a/pin', { pinned: true }),
  probe('PUT', '/documents/a/path', { path: 'b' }),
  probe('DELETE', '/documents/a'),
  probe('POST', '/documents/a/versions', { label: 'x' }),
  probe('GET', '/documents/a/versions/v1/document'),
  probe('POST', '/documents/a/versions/v1/restore'),
  probe('POST', '/replica-key'),
  probe('POST', '/replica-key/rotate'),
  probe('PUT', '/replica-tier', { tier: 'offline' }),
  pageProbe('GET', '/workspace-document/snapshot'),
  pageProbe('POST', '/workspace-document/update'),
]

async function call(daemon: Awaited<ReturnType<typeof app>>, route: Probe, workspace: string) {
  return daemon.request(route.path(workspace), {
    method: route.method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  })
}

describe('a workspace nothing answers to', () => {
  it('is probed on enough routes that the table is not empty', () => {
    expect(ROUTES.length).toBeGreaterThan(20)
  })

  for (const route of ROUTES) {
    const label = `${route.method} ${route.path(':workspaceId')}`
    it(`is 404 workspace_not_found on ${label}`, async () => {
      const res = await call(await app(), route, GONE)

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(apiErrorBodySchema.parse(body)).toEqual({
        error: 'workspace_not_found',
        message: expect.stringContaining(GONE),
      })
    })
  }
})

// The refusal is about a workspace that does not exist, never a blanket: an
// existing workspace that holds nothing is empty, and says so with a 200.
describe('a workspace that exists and holds nothing', () => {
  const EMPTY: readonly [string, Probe, unknown][] = [
    ['names', probe('GET', '/names'), { documents: {}, pinned: [] }],
    ['documents', probe('GET', '/documents'), { documents: [] }],
    ['trash', probe('GET', '/trash'), { entries: [] }],
    ['purge-dangling', probe('POST', '/files/purge-dangling'), { purgedCount: 0, purgedBytes: 0 }],
    [
      'prune-sandwiched',
      probe('POST', '/versions/prune-sandwiched'),
      { results: [], totalDeleted: 0 },
    ],
  ]
  for (const [name, route, expected] of EMPTY) {
    it(`is an empty 200 on ${name}`, async () => {
      const res = await call(await app(), route, KNOWN)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(expected)
    })
  }

  // The handle in the address is either layer (ADR-0019); the refusal must
  // judge what it resolves to, not the raw text.
  it('is found by its segment as well as by its id', async () => {
    const res = await call(await app(), probe('GET', '/names'), KNOWN_SEGMENT)

    expect(res.status).toBe(200)
  })
})

// Each route family words a malformed address in its own voice, and the guard
// leaves that to them rather than answering for all.
describe('a malformed workspace address', () => {
  it('is still the route’s own 400 on a plain route', async () => {
    const res = await call(await app(), probe('GET', '/names'), 'bad.handle')

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_workspace_id' })
  })

  it('is still Problem Details on a document route', async () => {
    const res = await call(await app(), probe('DELETE', '/documents/a'), 'bad.handle')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ title: expect.stringContaining('bad.handle') })
  })
})
