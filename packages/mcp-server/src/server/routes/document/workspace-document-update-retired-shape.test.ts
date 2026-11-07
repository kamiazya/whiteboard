/**
 * A shape an older version stored and no reader serves any more is refused
 * where an editor's update arrives: `400` with the code naming it, nothing
 * kept, and the document still readable afterwards.
 */
import {
  documentContainers,
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc, LoroMovableList } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  postDocumentEdit,
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-retired-shape-')

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
})

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createDocumentRouter } = await import('../document.js')

const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'
const PATH = 'canvas-a'

afterEach(() => {
  clearDocCacheForTests()
})

async function boardApp() {
  await createTestDocument(serverDeps, { workspaceId: WS, path: PATH })
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }),
  )
  const seeded = await postDocumentEdit(app, WS, PATH, (containers) =>
    writeSpatialCanvas(containers, {
      nodes: [textNode({ id: 'keep', text: 'keep', x: 0, y: 0, width: 10, height: 10 })],
      edges: [],
    }),
  )
  expect(seeded.status).toBe(200)
  return app
}

type App = Awaited<ReturnType<typeof boardApp>>

/** The record as the keeper serves it now. */
async function replicaOf(app: App): Promise<LoroDoc> {
  const snapshot = await app.request(`/api/w/${WS}/workspace-document/snapshot`)
  expect(snapshot.status).toBe(200)
  return LoroDoc.fromSnapshot(new Uint8Array(await snapshot.arrayBuffer()))
}

async function nodeIdsAfter(app: App): Promise<string[]> {
  const replica = await replicaOf(app)
  const entry = resolveWorkspaceDocument(replica, PATH)
  if (entry === null) throw new Error('the document is gone')
  return readSpatialCanvas(documentContainers(replica, entry.documentId)).nodes.map((n) => n.id)
}

describe('POST workspace-document/update writing a retired stored shape', () => {
  it('refuses a node under x-whiteboard with 400, keeping the document as it was', async () => {
    const app = await boardApp()

    const res = await postDocumentEdit(app, WS, PATH, (containers) =>
      containers.getMap('nodes').set('old', { id: 'old', 'x-whiteboard': { a: 1 } }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'retired_stored_shape',
      message: expect.stringContaining('x-whiteboard'),
    })
    expect(await nodeIdsAfter(app)).toEqual(['keep'])
  })

  it('refuses an entry in the elements list with 400, keeping the document as it was', async () => {
    const app = await boardApp()
    const replica = await replicaOf(app)
    const entry = resolveWorkspaceDocument(replica, PATH)
    const node = replica
      .getTree('tree')
      .getNodes()
      .find((candidate) => candidate.data.get('documentId') === entry?.documentId)
    const from = replica.oplogVersion()
    if (node === undefined) throw new Error('the document is gone')
    const list = node.data.setContainer('elements', new LoroMovableList())
    list.push({ id: 'old' })
    replica.commit()

    const res = await app.request(`/api/w/${WS}/workspace-document/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: replica.export({ mode: 'update', from }) as Uint8Array<ArrayBuffer>,
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'retired_stored_shape' })
    expect(await nodeIdsAfter(app)).toEqual(['keep'])
  })

  it('refuses a row in the flat comments plane with its own code', async () => {
    const app = await boardApp()

    const res = await postDocumentEdit(app, WS, PATH, (containers) =>
      containers.getMap('comments').set('c1', { id: 'c1' }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'retired_comment_plane' })
    expect(await nodeIdsAfter(app)).toEqual(['keep'])
  })

  it('still takes an ordinary edit afterwards', async () => {
    const app = await boardApp()
    await postDocumentEdit(app, WS, PATH, (containers) =>
      containers.getMap('nodes').set('old', { id: 'old', 'x-whiteboard': {} }),
    )

    const res = await postDocumentEdit(app, WS, PATH, (containers) =>
      writeSpatialCanvas(containers, {
        nodes: [textNode({ id: 'next', text: 'n', x: 0, y: 0, width: 10, height: 10 })],
        edges: [],
      }),
    )

    expect(res.status).toBe(200)
    expect(await nodeIdsAfter(app)).toEqual(['next'])
  })
})
