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

/** A document whose node is stored the way a record written before the node shape changed holds it. */
function retiredNodeUpdate(): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  doc.getMap('nodes').set('old', { id: 'old', type: 'text', text: 'old shape' })
  doc.commit()
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array<ArrayBuffer>
}

describe('a restore over a version holding a retired shape', () => {
  it('is refused and writes nothing, as a sync write of it would be', async () => {
    const app = createRouter()
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', nodesModelDocUpdate(['v1-node']))
    const documentId = await documentIdAt(serverDeps, WS, 'canvas-a')
    const saved = await app.request(`/api/workspaces/${WS}/documents/${documentId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saved.json()) as { version: { id: string } }
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', retiredNodeUpdate())
    await app.request(`/api/workspaces/${WS}/documents/${documentId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'old' }),
    })
    const old = (await serverDeps.versions.list(WS, 'canvas-a')).find((v) => v.label === 'old')
    const digestBefore = (
      await serverDeps.documentIndex.resolveDocument({ workspaceId: WS, path: 'canvas-a' })
    )?.contentDigest
    const res = await app.request(
      `/api/workspaces/${WS}/documents/${documentId}/versions/${old?.id}/restore`,
      { method: 'POST' },
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('retired_stored_shape')
    expect(
      (await serverDeps.documentIndex.resolveDocument({ workspaceId: WS, path: 'canvas-a' }))
        ?.contentDigest,
    ).toBe(digestBefore)
    const points = (await serverDeps.versions.list(WS, 'canvas-a')).filter(
      (v) => v.restoredFrom !== undefined,
    )
    expect(points).toEqual([])
    expect(version.id).toBeDefined()
  })
})
