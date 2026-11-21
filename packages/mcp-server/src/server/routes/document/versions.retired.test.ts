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

const tmp = withTempDataDir('whiteboard-preview-retired-test-')
const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WS })
})

const { createDocumentRouter } = await import('../document.js')
// Pre-loaded for the same dynamic-import cycle restore.test.ts works around.
await import('../../sync-audience.js')

function retiredNodeUpdate(): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  doc.getMap('nodes').set('old', { id: 'old', type: 'text', text: 'old shape' })
  doc.commit()
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array<ArrayBuffer>
}

function currentUpdate(): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'v1', text: 'v1', x: 0, y: 0, width: 10, height: 10 })],
    edges: [],
  })
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array<ArrayBuffer>
}

describe('a preview of a version holding a retired shape', () => {
  it('is refused with the code and status a restore of it is refused with', async () => {
    const app = createDocumentRouter(
      testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }),
    )
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', currentUpdate())
    const documentId = await documentIdAt(serverDeps, WS, 'canvas-a')
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', retiredNodeUpdate())
    await app.request(`/api/workspaces/${WS}/documents/${documentId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'old' }),
    })
    const old = (await serverDeps.versions.list(WS, 'canvas-a')).find((v) => v.label === 'old')

    const restore = await app.request(
      `/api/workspaces/${WS}/documents/${documentId}/versions/${old?.id}/restore`,
      { method: 'POST' },
    )
    const preview = await app.request(
      `/api/workspaces/${WS}/documents/${documentId}/versions/${old?.id}/document`,
    )

    expect(restore.status).toBe(400)
    expect(preview.status).toBe(restore.status)
    expect(((await preview.json()) as { error: string }).error).toBe('retired_stored_shape')
  })
})
