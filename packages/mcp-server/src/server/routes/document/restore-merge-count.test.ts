import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  documentIdAt,
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

// A restore's merge point counts the nodes of the state the restore left, which is read from the
// stored record after the restore was saved, never from the state it replaced.
const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'

async function seedTwoStates(app: ReturnType<typeof createRouter>, path: string): Promise<string> {
  await writeDocumentUpdate(serverDeps, WS, path, nodesModelDocUpdate(['v1-node']))
  const saved = await app.request(
    `/api/workspaces/${WS}/documents/${await documentIdAt(serverDeps, WS, path)}/versions`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"label":"v1"}' },
  )
  const { version } = (await saved.json()) as { version: { id: string } }
  await writeDocumentUpdate(serverDeps, WS, path, nodesModelDocUpdate(['b', 'c']))
  return version.id
}

const mergeCounts = async (path: string) =>
  (await serverDeps.versions.list(WS, path))
    .filter((v) => v.restoredFrom !== undefined)
    .map((v) => v.elementCount)

describe('the restore point records the restored node count', () => {
  it('in place: one node after restoring a version of one, from three', async () => {
    const app = createRouter()
    const v1 = await seedTwoStates(app, 'canvas-a')
    const res = await app.request(
      `/api/workspaces/${WS}/documents/${await documentIdAt(serverDeps, WS, 'canvas-a')}/versions/${v1}/restore`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    expect(await mergeCounts('canvas-a')).toEqual([1])
  })

  it('onto an existing target: the target holds one node afterwards', async () => {
    const app = createRouter()
    const v1 = await seedTwoStates(app, 'canvas-a')
    await writeDocumentUpdate(serverDeps, WS, 'canvas-b', nodesModelDocUpdate(['x', 'y', 'z']))
    const res = await app.request(
      `/api/workspaces/${WS}/documents/${await documentIdAt(serverDeps, WS, 'canvas-a')}/versions/${v1}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-b', overwrite: true }),
      },
    )
    expect(res.status).toBe(200)
    expect(await mergeCounts('canvas-b')).toEqual([1])
  })

  it('into a new target: the copy holds one node', async () => {
    const app = createRouter()
    const v1 = await seedTwoStates(app, 'canvas-a')
    const res = await app.request(
      `/api/workspaces/${WS}/documents/${await documentIdAt(serverDeps, WS, 'canvas-a')}/versions/${v1}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-new' }),
      },
    )
    expect(res.status).toBe(200)
    expect(await mergeCounts('canvas-new')).toEqual([1])
  })
})
