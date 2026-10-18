import { MAX_RESTORE_POINTS_PER_DOCUMENT } from '@kamiazya/whiteboard-history'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-restore-points-test-')

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: 'session1' })
})

const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createDocumentRouter } = await import('../document.js')
// Pre-loaded for the same dynamic-import cycle restore.test.ts works around.
await import('../../sync-audience.js')

const indexedIdAt = async (path: string) =>
  (await serverDeps.documentIndex.resolveDocument({ workspaceId: 'session1', path }))?.documentId

const createRouter = () =>
  createDocumentRouter(testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }))

beforeEach(clearDocCacheForTests)
afterEach(clearDocCacheForTests)

function nodesModelDocUpdate(nodeIds: string[]): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: nodeIds.map((id) => textNode({ id, text: id, x: 0, y: 0, width: 10, height: 10 })),
    edges: [],
  })
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array<ArrayBuffer>
}

// A restore records its merge point as lineage, which no retention pass
// takes — so a restore loop is a way to grow a document's history forever
// unless the keeper bounds merge points itself.
describe('restore points stay bounded', () => {
  async function seedEditedCanvas(app: ReturnType<typeof createRouter>): Promise<string> {
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['v1-node']),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saveRes.json()) as { version: { id: string } }
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['after-v1']),
    })
    // The newest version holds the edit, so restoring v1 really changes the
    // document rather than restating what the history already records.
    await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v2' }),
    })
    return version.id
  }

  const restorePoints = async () =>
    (await serverDeps.versions.list('session1', 'canvas-a')).filter(
      (v) => v.restoredFrom !== undefined,
    )

  it('records no further merge point once the document holds the most it keeps', async () => {
    const app = createRouter()
    const v1 = await seedEditedCanvas(app)
    const documentId = await indexedIdAt('canvas-a')
    if (documentId === undefined) throw new Error('canvas-a is not indexed')
    await serverDeps.versions.adopt(
      'session1',
      Array.from({ length: MAX_RESTORE_POINTS_PER_DOCUMENT }, (_, i) => ({
        id: `merge-${String(i).padStart(4, '0')}`,
        documentId,
        createdAt: 1 + i,
        auto: true,
        restoredFrom: v1,
        frontiers: [],
        elementCount: 0,
        contentDigest: 'x',
      })),
    )
    expect(await restorePoints()).toHaveLength(MAX_RESTORE_POINTS_PER_DOCUMENT)

    const res = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${v1}/restore`,
      { method: 'POST' },
    )
    // The restore itself still lands: only its merge point is dropped.
    expect(res.status).toBe(200)
    expect(await restorePoints()).toHaveLength(MAX_RESTORE_POINTS_PER_DOCUMENT)
  })

  it('records one merge point for a restore repeated over an unchanged document', async () => {
    const app = createRouter()
    const v1 = await seedEditedCanvas(app)
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request(
        `/api/workspaces/session1/documents/canvas-a/versions/${v1}/restore`,
        { method: 'POST' },
      )
      expect(res.status).toBe(200)
    }
    expect(await restorePoints()).toHaveLength(1)
  })
})
