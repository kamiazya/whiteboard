// @vitest-environment node
/**
 * `/api/w/:workspaceId/document/*` answers a handle no workspace holds with the
 * refusal `/api/v1` and the legacy `/api/workspaces/:workspaceId/*` routes give
 * (404 `workspace_not_found`), and creates nothing on the way.
 *
 * These routes take their handle through a resolve-or-pass-through, so an
 * unknown one used to arrive at the store as a workspace id: an update minted a
 * workspace row under whatever the caller typed, and an upload created its
 * files directory. A workspace comes from the workspaces route and nowhere else.
 *
 * The routes are read off the registered surface rather than listed here, so a
 * document action added tomorrow is held to the same answer or fails this file.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../../../di/container.js'
import { createSelfHostStoreLocalModule } from '../../../di/store-local.module.js'
import { registeredKeys } from '../../_test-route-fuzz-lane.js'
import {
  bearerNamesItsSubject,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from '../../_test-server-mode-harness.js'
import { SESSION_COOKIE } from '../../security/sign-in-session-store.js'
import { createWorkspaceReplicaKeyStore } from '../../security/workspace-replica-key-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../../store/db/test-helpers.js'
import { testDataLayout } from '../_test-helpers.js'

let dataDir = ''
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('../../app.js')

const TOKEN = 'unknown-workspace-handle-token'
const GONE = 'nowhere'
const KNOWN = 'ws-known'
const KNOWN_SEGMENT = 'known-segment'

let handle: IsolatedDbHandle | undefined
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-unknown-workspace-handle-'))
})
afterEach(async () => {
  await handle?.dispose()
  handle = undefined
  await rm(dataDir, { recursive: true, force: true })
})

async function daemon() {
  handle = await createIsolatedDb({ dataDir })
  const serverDeps = resolveServerDeps(
    createContainer(createSelfHostStoreLocalModule(handle.db, dataDir)),
  )
  await serverDeps.documentIndex.createWorkspace({ workspaceId: KNOWN, segment: KNOWN_SEGMENT })
  const app = createApp({
    authMode: 'local-daemon',
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({}) as never,
    serverDeps,
    dataLayout: testDataLayout(),
    replicaKeys: createWorkspaceReplicaKeyStore(handle.db, { defaultTier: 'offline' }),
  })
  return { app, serverDeps }
}

type Daemon = Awaited<ReturnType<typeof daemon>>

const loroUpdate = (): Uint8Array<ArrayBuffer> => {
  const doc = new LoroDoc()
  doc.getMap('m').set('k', 'v')
  doc.commit()
  return doc.export({ mode: 'update' }) as Uint8Array<ArrayBuffer>
}

interface Probe {
  readonly method: string
  readonly suffix: string
  readonly init: { headers: Record<string, string>; body?: BodyInit }
}

const PROBE_PATTERN = /^(\w+) \/api\/w\/:workspaceId\/document\/\*\/(.+)$/

/** What a request to one action carries: enough that nothing but the workspace can refuse it. */
function probeFor(method: string, action: string): Probe {
  const suffix = `/document/doc/${action.replace(':fileId', 'abc')}`
  if (action.startsWith('file/')) {
    return method === 'PUT'
      ? {
          method,
          suffix,
          init: { headers: { 'content-type': 'image/png' }, body: new Uint8Array([1, 2, 3]) },
        }
      : { method, suffix, init: { headers: {} } }
  }
  if (method === 'POST' && action === 'update') {
    return {
      method,
      suffix,
      init: { headers: { 'content-type': 'application/octet-stream' }, body: loroUpdate() },
    }
  }
  if (method === 'POST') {
    return {
      method,
      suffix,
      init: { headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
    }
  }
  return { method, suffix, init: { headers: {} } }
}

async function documentProbes(): Promise<Probe[]> {
  const { app } = await daemon()
  return registeredKeys(app).flatMap((key) => {
    const match = PROBE_PATTERN.exec(key)
    return match === null ? [] : [probeFor(match[1] as string, match[2] as string)]
  })
}

function send(d: Daemon, probe: Probe, workspace: string) {
  return d.app.request(`/api/w/${workspace}${probe.suffix}`, {
    method: probe.method,
    ...probe.init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...probe.init.headers },
  })
}

/** Every directory under the data dir: a workspace's files directory is one, and the database is not. */
async function directories(): Promise<string[]> {
  const entries = await readdir(dataDir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

describe('a handle no workspace holds, on the document routes', () => {
  it('is probed on every action the router registers', async () => {
    const probes = await documentProbes()
    const labels = probes.map((p) => `${p.method} ${p.suffix}`)

    // snapshot, update, client-count, export, export-svg and the file pair.
    expect(probes.length).toBeGreaterThanOrEqual(7)
    expect(labels).toContain('POST /document/doc/update')
    expect(labels).toContain('PUT /document/doc/file/abc')
  })

  it('is 404 workspace_not_found on each, and nothing is created', async () => {
    const d = await daemon()
    const probes = await documentProbes()
    const workspacesBefore = await d.serverDeps.documentIndex.listWorkspaces()
    const directoriesBefore = await directories()

    for (const probe of probes) {
      const label = `${probe.method} ${probe.suffix}`
      const res = await send(d, probe, GONE)

      expect(res.status, label).toBe(404)
      expect(apiErrorBodySchema.parse(await res.json()), label).toEqual({
        error: 'workspace_not_found',
        message: expect.stringContaining(GONE),
      })
    }

    expect(await d.serverDeps.documentIndex.listWorkspaces()).toEqual(workspacesBefore)
    expect(await d.serverDeps.documentIndex.resolveWorkspace(GONE)).toBeNull()
    expect(await directories()).toEqual(directoriesBefore)
  })

  it('lists no workspace afterwards on GET /api/workspaces', async () => {
    const d = await daemon()
    const update = probeFor('POST', 'update')
    await send(d, update, GONE)

    const res = await d.app.request('/api/workspaces', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    const { workspaces } = (await res.json()) as { workspaces: { workspaceId: string }[] }

    expect(workspaces.map((w) => w.workspaceId)).toEqual([KNOWN])
  })
})

// The refusal is about a workspace that does not exist, never a blanket: the
// handle is either layer of the address (ADR-0019), and a workspace created
// the proper way answers these routes as before.
describe('a workspace that exists, on the document routes', () => {
  it.each([
    ['its id', KNOWN],
    ['its segment', KNOWN_SEGMENT],
  ])('takes an update and an upload addressed by %s', async (_label, address) => {
    const d = await daemon()

    const update = await send(d, probeFor('POST', 'update'), address)
    const upload = await send(d, probeFor('PUT', 'file/:fileId'), address)

    expect(update.status).toBe(200)
    expect(upload.status).toBe(204)
  })

  it('answers client-count with zeros rather than refusing a document nobody has open', async () => {
    const d = await daemon()

    const res = await send(d, probeFor('GET', 'client-count'), KNOWN)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 0, readyCount: 0 })
  })

  it('answers a document that was never created with a not_found refusal, not the workspace one', async () => {
    const d = await daemon()

    const res = await send(d, probeFor('GET', 'snapshot'), KNOWN)

    expect(res.status).toBe(404)
    expect(apiErrorBodySchema.parse(await res.json())).toEqual({
      error: 'not_found',
      message: expect.stringContaining('doc'),
    })
  })
})

// A tab that still holds a document someone deleted keeps writing to it. The
// write must not recreate the path as a second, unrelated document while the
// original sits in Trash. A path that was never created is a different case:
// the first write from an open page is how a document begins there.
describe('a document in the trash, on the document routes', () => {
  async function trashed(d: Daemon, address: string): Promise<void> {
    const made = await send(d, probeFor('POST', 'update'), address)
    expect(made.status).toBe(200)
    const gone = await d.app.request(`/api/workspaces/${address}/documents/doc`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(gone.status).toBe(200)
  }
  const liveDocuments = async (d: Daemon) =>
    (await d.serverDeps.documentIndex.listDocuments({ workspaceId: KNOWN })).map((e) => e.path)

  it.each([
    ['an update', probeFor('POST', 'update')],
    ['an upload', probeFor('PUT', 'file/:fileId')],
  ])('refuses %s and recreates nothing', async (_label, probe) => {
    const d = await daemon()
    await trashed(d, KNOWN)

    const res = await send(d, probe, KNOWN)

    expect(res.status).toBe(404)
    expect(apiErrorBodySchema.parse(await res.json())).toEqual({
      error: 'not_found',
      message: expect.stringContaining('doc'),
    })
    expect(await liveDocuments(d)).toEqual([])
  })

  it('still lets the first write from an open page begin a document that was never created', async () => {
    const d = await daemon()

    const res = await send(d, probeFor('POST', 'update'), KNOWN)

    expect(res.status).toBe(200)
    expect(await liveDocuments(d)).toEqual(['doc'])
  })

  it('takes writes again once a document is created at the path the trash entry names', async () => {
    const d = await daemon()
    await trashed(d, KNOWN)
    await d.serverDeps.liveDocuments.save(KNOWN, 'doc', new LoroDoc(), { kind: 'spatial' })

    const res = await send(d, probeFor('POST', 'update'), KNOWN)

    expect(res.status).toBe(200)
  })
})

describe('a malformed workspace address, on the document routes', () => {
  it('is still the route’s own Problem Details 400', async () => {
    const d = await daemon()

    const res = await send(d, probeFor('POST', 'update'), 'bad.handle')

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_workspace_id' })
  })

  it('leaves a malformed document path to the route’s own 400 on a workspace that exists', async () => {
    const d = await daemon()

    const res = await d.app.request(`/api/w/${KNOWN}/document/bad.path/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: loroUpdate(),
    })

    expect(res.status).toBe(400)
  })
})

// The refusal above would tell a stranger which workspaces exist if it ran
// before the membership gate, so server mode answers a workspace the caller is
// not in the same way whether or not it exists.
describe('server mode, on the document routes', () => {
  it('answers a signed-in non-member not_a_member for a workspace that does not exist, as for one that does', async () => {
    handle = await createIsolatedDb({ dataDir })
    const stores = serverModePeople(handle.db, dataDir)
    const app = createApp({
      authMode: 'server-mode',
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [PUBLIC_URL],
      authStrategy: bearerNamesItsSubject,
      serverDeps: resolveServerDeps(
        createContainer(createSelfHostStoreLocalModule(handle.db, dataDir)),
      ),
      dataLayout: testDataLayout(),
      people: stores.people,
      touch: () => {},
      getStatus: () => {
        throw new Error('not read by these routes')
      },
    })
    const signedIn = async (subject: string) => {
      const binding = { authenticator: ISSUER, subject }
      await stores.members.ensureProfile({ binding, displayName: subject })
      const token = await stores.sessions.create(binding, Date.now(), 60_000, Date.now())
      return { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL }
    }
    const ada = await signedIn('ada')
    const eve = await signedIn('eve')
    const created = await app.request(`${PUBLIC_URL}/api/workspaces`, {
      method: 'POST',
      headers: { ...ada, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Plans' }),
    })
    const { workspaceId } = (await created.json()) as { workspaceId: string }
    const update = probeFor('POST', 'update')
    const asEve = (workspace: string) =>
      app.request(`${PUBLIC_URL}/api/w/${workspace}${update.suffix}`, {
        method: 'POST',
        headers: { ...eve, ...update.init.headers },
        ...(update.init.body === undefined ? {} : { body: update.init.body }),
      })

    const real = await asEve(workspaceId)
    const absent = await asEve(GONE)

    expect(real.status).toBe(403)
    expect(absent.status).toBe(403)
    expect(await real.json()).toMatchObject({ error: 'not_a_member' })
    expect(await absent.json()).toMatchObject({ error: 'not_a_member' })
  })
})
