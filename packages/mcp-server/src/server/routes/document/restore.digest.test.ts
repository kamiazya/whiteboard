import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const { createDocumentRouter } = await import('../document.js')
// Pre-loaded for the same dynamic-import cycle restore.test.ts works around.
await import('../../sync-audience.js')

const createRouter = () =>
  createDocumentRouter(testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }))

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

const digestAt = async (path: string) =>
  (await serverDeps.documentIndex.resolveDocument({ workspaceId: WS, path }))?.contentDigest

// What a restore in place leaves the document holding, as the identity of its
// content: the version's own, whichever way the past state is written back.
describe('an in-place restore', () => {
  async function restoreOnce(app: ReturnType<typeof createRouter>) {
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', nodesModelDocUpdate(['v1-node']))
    const documentId = await documentIdAt(serverDeps, WS, 'canvas-a')
    const digestAtV1 = await digestAt('canvas-a')
    const saved = await app.request(`/api/workspaces/${WS}/documents/${documentId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saved.json()) as { version: { id: string } }
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', nodesModelDocUpdate(['after-v1']))
    const digestAfterEdit = await digestAt('canvas-a')
    const res = await app.request(
      `/api/workspaces/${WS}/documents/${documentId}/versions/${version.id}/restore`,
      { method: 'POST' },
    )
    return { res, digestAtV1, digestAfterEdit, versionId: version.id }
  }

  it('leaves the document with the content digest the version was saved at', async () => {
    const { res, digestAtV1, digestAfterEdit } = await restoreOnce(createRouter())
    expect(res.status).toBe(200)
    expect(digestAfterEdit).not.toBe(digestAtV1)
    expect(await digestAt('canvas-a')).toBe(digestAtV1)
  })

  it('answers changed for a restore that moved the content, and unchanged for one repeated', async () => {
    const app = createRouter()
    const { res, versionId } = await restoreOnce(app)
    expect(res.status).toBe(200)
    const points = async () =>
      (await serverDeps.versions.list(WS, 'canvas-a')).filter((v) => v.restoredFrom !== undefined)
    expect(await points()).toHaveLength(1)
    // The restore point names the version that was saved and restored.
    expect((await points())[0]?.restoredFrom).toBe(versionId)
    const again = await app.request(
      `/api/workspaces/${WS}/documents/${await documentIdAt(serverDeps, WS, 'canvas-a')}/versions/${versionId}/restore`,
      { method: 'POST' },
    )
    expect(again.status).toBe(200)
    expect(await points()).toHaveLength(1)
  })
})
