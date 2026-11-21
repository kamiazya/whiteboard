import {
  documentContainers,
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeSpatialCanvas,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  documentIdAt,
  documentOf,
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
  writeDocumentUpdate,
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
  await serverDeps.documentIndex.createWorkspace({ workspaceId: '01M8BBN7JS60N0ZAR13NP8SXBF' })
})

const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createDocumentRouter } = await import('../document.js')
// Pre-loaded for the same dynamic-import cycle restore.test.ts works around.
await import('../../sync-audience.js')

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

const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'
const { onWorkspaceDocUpdated } = await import('../../store/document-store.js')

const nodeIdsIn = (replica: LoroDoc, path: string) => {
  const entry = resolveWorkspaceDocument(replica, path)
  if (entry === null) throw new Error(`no document at ${path}`)
  return readSpatialCanvas(documentContainers(replica, entry.documentId))
    .nodes.map((node) => node.id)
    .sort()
}

async function replicaOf(app: ReturnType<typeof createRouter>): Promise<LoroDoc> {
  const snapshot = await app.request(`/api/w/${WS}/workspace-document/snapshot`)
  return LoroDoc.fromSnapshot(new Uint8Array(await snapshot.arrayBuffer()))
}

// A restore reaches a second client through the save's fan-out, and a client
// still holding the state from before it cannot write that state back.
describe('a restore with a second client attached', () => {
  async function seedAndSaveVersion(app: ReturnType<typeof createRouter>) {
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', nodesModelDocUpdate(['v1-node']))
    const documentId = await documentIdAt(serverDeps, WS, 'canvas-a')
    const saved = await app.request(`/api/workspaces/${WS}/documents/${documentId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saved.json()) as { version: { id: string } }
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', nodesModelDocUpdate(['after-v1']))
    return { documentId, versionId: version.id }
  }

  it('hands a follower synced before it the restored content through the save fan-out', async () => {
    const app = createRouter()
    const { documentId, versionId } = await seedAndSaveVersion(app)
    const follower = await replicaOf(app)
    expect(nodeIdsIn(follower, 'canvas-a')).toEqual(['after-v1', 'v1-node'].sort())
    const heard: Uint8Array[] = []
    const stop = onWorkspaceDocUpdated((workspaceId, update) => {
      if (workspaceId === WS) heard.push(update)
    })
    const res = await app.request(
      `/api/workspaces/${WS}/documents/${documentId}/versions/${versionId}/restore`,
      { method: 'POST' },
    )
    stop()
    expect(res.status).toBe(200)
    for (const update of heard) follower.import(update)
    expect(heard.length).toBeGreaterThan(0)
    expect(nodeIdsIn(follower, 'canvas-a')).toEqual(nodeIdsIn(await replicaOf(app), 'canvas-a'))
  })

  it('does not let a client holding the state from before the restore write it back', async () => {
    const app = createRouter()
    const { documentId, versionId } = await seedAndSaveVersion(app)
    const stale = await replicaOf(app)
    await app.request(
      `/api/workspaces/${WS}/documents/${documentId}/versions/${versionId}/restore`,
      { method: 'POST' },
    )
    const before = stale.oplogVersion()
    writeSpatialNode(documentContainers(stale, documentId), {
      id: 'client-added',
      type: 'text',
      text: 'edit',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    } as never)
    stale.commit()
    const sent = await app.request(`/api/w/${WS}/workspace-document/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: stale.export({ mode: 'update', from: before }) as Uint8Array<ArrayBuffer>,
    })
    expect(sent.status).toBe(200)
    const record = await replicaOf(app)
    expect(nodeIdsIn(record, 'canvas-a')).toEqual(['client-added', 'v1-node'])
    // The live document the next reader gets is the record's, not a copy cut before the restore.
    const live = await documentOf(serverDeps, WS, 'canvas-a')
    expect(
      readSpatialCanvas(live)
        .nodes.map((node) => node.id)
        .sort(),
    ).toEqual(['client-added', 'v1-node'])
  })
})
