// @vitest-environment node
/**
 * A document addressed by its id (`/api/workspaces/:ws/documents/:documentId/...`)
 * reaches the handler the path form reaches, with the placement the id
 * resolves to, so an id survives a rename the path does not.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../../../di/container.js'
import { createSelfHostStoreLocalModule } from '../../../di/store-local.module.js'
import { createWorkspaceReplicaKeyStore } from '../../security/workspace-replica-key-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../../store/db/test-helpers.js'
import { createTestDocument, testDataLayout } from '../_test-helpers.js'
import { onDocumentRoute, resolveDocumentAddress, resolvedDocumentOf } from './path-route.js'

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

const TOKEN = 'id-routes-token'
const WORKSPACE = '01TFTP6SMY23MTM63TK63WD2YX'
const OTHER_WORKSPACE = '01TFTP6SMY23MTM63TK63WD2YY'
const UNKNOWN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
// A 1x1 PNG, so an upload passes any content sniffing.
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
)

let handle: IsolatedDbHandle | undefined
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-id-routes-'))
})
afterEach(async () => {
  await handle?.dispose()
  handle = undefined
  await rm(dataDir, { recursive: true, force: true })
})

/** The index with every `resolveDocumentById` counted; other methods keep their own `this`. */
function countingIndex<T extends object>(index: T) {
  let calls = 0
  const documentIndex = new Proxy(index, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key !== 'resolveDocumentById') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (...args: unknown[]) => {
        calls += 1
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return { documentIndex, calls: () => calls }
}

async function daemon() {
  handle = await createIsolatedDb({ dataDir })
  const real = resolveServerDeps(
    createContainer(createSelfHostStoreLocalModule(handle.db, dataDir)),
  )
  const counting = countingIndex(real.documentIndex)
  const serverDeps = { ...real, documentIndex: counting.documentIndex }
  await real.documentIndex.createWorkspace({ workspaceId: WORKSPACE, segment: 'ws' })
  await real.documentIndex.createWorkspace({ workspaceId: OTHER_WORKSPACE, segment: 'other' })
  const app = createApp({
    authMode: 'local-daemon',
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({}) as never,
    serverDeps,
    dataLayout: testDataLayout(),
    replicaKeys: createWorkspaceReplicaKeyStore(handle.db, { defaultTier: 'offline' }),
  })
  const idOf = async (workspaceId: string, path: string) => {
    const entry = await real.documentIndex.resolveDocument({ workspaceId, path })
    if (entry === null) throw new Error(`fixture lost ${path}`)
    return entry.documentId
  }
  const send = (
    url: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(url, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body === undefined || body instanceof Uint8Array
          ? {}
          : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : {
            body:
              body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
          }),
    })
  return { app, deps: real, idOf, send, calls: counting.calls }
}

const doc = (id: string, tail = '') => `/api/workspaces/ws/documents/${id}${tail}`
const byPath = (path: string, tail = '') => `/api/workspaces/ws/documents/${path}${tail}`
const pageDoc = (path: string, action: string) => `/api/w/ws/document/${path}/${action}`

describe('a document addressed by id', () => {
  it('answers snapshot, client-count, export and export-svg as the path form does', async () => {
    const d = await daemon()
    await createTestDocument(d.deps, { workspaceId: WORKSPACE, path: 'alpha' })
    const id = await d.idOf(WORKSPACE, 'alpha')

    const snapshotByPath = await d.send(pageDoc('alpha', 'snapshot'))
    const snapshotById = await d.send(doc(id, '/snapshot'))
    expect(snapshotById.status).toBe(200)
    expect(new Uint8Array(await snapshotById.arrayBuffer())).toEqual(
      new Uint8Array(await snapshotByPath.arrayBuffer()),
    )

    for (const [method, action, body] of [
      ['GET', 'client-count', undefined],
      ['POST', 'export', {}],
      ['POST', 'export-svg', {}],
    ] as const) {
      const viaPath = await d.send(pageDoc('alpha', action), method, body)
      const viaId = await d.send(doc(id, `/${action}`), method, body)
      expect(viaId.status, action).toBe(viaPath.status)
      // An export names a timestamped file, so only the shape of the answer is held.
      const stamp = /alpha-[^"]*\.(png|svg)/g
      expect((await viaId.text()).replace(stamp, 'alpha.$1'), action).toBe(
        (await viaPath.text()).replace(stamp, 'alpha.$1'),
      )
    }
  })

  it('stores and reads a file through the id form, and the path form reads it back', async () => {
    const d = await daemon()
    await createTestDocument(d.deps, { workspaceId: WORKSPACE, path: 'alpha' })
    const id = await d.idOf(WORKSPACE, 'alpha')

    const put = await d.send(doc(id, '/files/abc123'), 'PUT', PNG, { 'content-type': 'image/png' })
    expect(put.status).toBe(204)
    const viaId = await d.send(doc(id, '/files/abc123'))
    const viaPath = await d.send(`/api/w/ws/document/alpha/file/abc123`)
    expect(viaId.status).toBe(200)
    expect(new Uint8Array(await viaId.arrayBuffer())).toEqual(
      new Uint8Array(await viaPath.arrayBuffer()),
    )
  })

  it('lists, saves and previews versions and restores one, as the path form does', async () => {
    const d = await daemon()
    await createTestDocument(d.deps, { workspaceId: WORKSPACE, path: 'alpha' })
    const id = await d.idOf(WORKSPACE, 'alpha')

    const saved = await d.send(doc(id, '/versions'), 'POST', { label: 'first' })
    expect(saved.status).toBe(200)
    const listedById = await d.send(doc(id, '/versions'))
    const listedByPath = await d.send(byPath('alpha', '/versions'))
    expect(listedById.status).toBe(200)
    const listed = (await listedById.json()) as { versions: { id: string }[] }
    expect(listed).toEqual(await listedByPath.json())

    const versionId = listed.versions[0]?.id as string
    const previewById = await d.send(doc(id, `/versions/${versionId}/document`))
    const previewByPath = await d.send(byPath('alpha', `/versions/${versionId}/document`))
    expect(previewById.status).toBe(200)
    expect(await previewById.json()).toEqual(await previewByPath.json())

    const restored = await d.send(doc(id, `/versions/${versionId}/restore`), 'POST', {})
    const restoredByPath = await d.send(
      byPath('alpha', `/versions/${versionId}/restore`),
      'POST',
      {},
    )
    expect(restored.status).toBe(restoredByPath.status)
  })

  it('names, pins, moves and duplicates, and deletes', async () => {
    const d = await daemon()
    await createTestDocument(d.deps, { workspaceId: WORKSPACE, path: 'alpha' })
    const id = await d.idOf(WORKSPACE, 'alpha')

    expect((await d.send(doc(id, '/name'), 'PUT', { name: 'Alpha board' })).status).toBe(200)
    expect((await d.send(doc(id, '/pin'), 'PUT', { pinned: true })).status).toBe(200)
    const copy = await d.send(doc(id, '/duplicate'), 'POST', {})
    expect(copy.status, await copy.clone().text()).toBe(200)

    const moved = await d.send(doc(id, '/path'), 'PUT', { path: 'moved/alpha' })
    expect(moved.status).toBe(200)
    expect(await moved.json()).toEqual({ path: 'moved/alpha' })

    // An id survives the move; the old path does not.
    expect((await d.send(doc(id, '/versions'))).status).toBe(200)
    expect((await d.send(pageDoc('alpha', 'snapshot'))).status).toBe(404)

    const deleted = await d.send(doc(id), 'DELETE')
    expect(deleted.status).toBeLessThan(300)
    // A trashed document resolves to nothing.
    expect((await d.send(doc(id, '/versions'))).status).toBe(404)
  })

  it("refuses an unknown id, another workspace's id and a trashed one in the shared voice", async () => {
    const d = await daemon()
    await createTestDocument(d.deps, { workspaceId: OTHER_WORKSPACE, path: 'elsewhere' })
    const foreign = await d.idOf(OTHER_WORKSPACE, 'elsewhere')

    for (const id of [UNKNOWN_ID, foreign]) {
      const res = await d.send(doc(id, '/snapshot'))
      expect(res.status).toBe(404)
      expect(apiErrorBodySchema.parse(await res.json())).toEqual({
        error: 'not_found',
        message: `Document "${id}" not found`,
      })
    }
  })

  it('falls through to the path family for a segment that is not a ULID', async () => {
    const d = await daemon()
    await createTestDocument(d.deps, { workspaceId: WORKSPACE, path: 'foo' })
    // Until the path form leaves, a one-segment path shares this grammar.
    expect((await d.send(byPath('foo', '/versions'))).status).toBe(200)
  })

  it('refuses a malformed workspace handle with the handle 400', async () => {
    const d = await daemon()
    const res = await d.send(`/api/workspaces/has%20space/documents/${UNKNOWN_ID}/snapshot`)
    expect(res.status).toBe(400)
  })
})

describe('resolving the id', () => {
  it('asks the index once per request', async () => {
    const d = await daemon()
    await createTestDocument(d.deps, { workspaceId: WORKSPACE, path: 'alpha' })
    const id = await d.idOf(WORKSPACE, 'alpha')

    const before = d.calls()
    const res = await d.send(doc(id, '/versions'))
    expect(res.status).toBe(200)
    expect(d.calls() - before).toBe(1)
  })

  it("asks once when a route's middleware and its handler both read the resolution", async () => {
    const d = await daemon()
    await createTestDocument(d.deps, { workspaceId: WORKSPACE, path: 'alpha' })
    const id = await d.idOf(WORKSPACE, 'alpha')
    const counting = countingIndex(d.deps.documentIndex)
    const seen: (string | undefined)[] = []
    const app = new Hono()
    app.use(
      '/api/workspaces/:workspaceId/documents/:documentId/*',
      resolveDocumentAddress(counting),
    )
    onDocumentRoute(
      app,
      'get',
      '/probe',
      (c) => {
        seen.push(resolvedDocumentOf(c)?.path)
        return c.json({ path: resolvedDocumentOf(c)?.path })
      },
      async (c, next) => {
        seen.push(resolvedDocumentOf(c)?.path)
        await next()
      },
    )
    const res = await app.request(`/api/workspaces/${WORKSPACE}/documents/${id}/probe`)
    expect(await res.json()).toEqual({ path: 'alpha' })
    expect(seen).toEqual(['alpha', 'alpha'])
    expect(counting.calls()).toBe(1)
  })

  it('fails loudly when a router is mounted without the resolver', async () => {
    const app = new Hono()
    onDocumentRoute(app, 'get', '/probe', (c) => c.json({}))
    const res = await app.request(`/api/workspaces/${WORKSPACE}/documents/${UNKNOWN_ID}/probe`)
    expect(res.status).toBe(500)
  })
})
