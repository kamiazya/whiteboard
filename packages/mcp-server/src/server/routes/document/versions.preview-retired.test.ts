/**
 * Previewing a saved version whose state holds a shape no reader serves any
 * more is refused rather than shown as an empty document. Nothing on this route
 * maps the refusal, so it answers as an unhandled error does (500); the restore
 * of the same version answers 400. Pinned as it is so a move of the read keeps
 * the answer it has.
 */
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

const tmp = withTempDataDir('whiteboard-preview-retired-')
const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WS })
})

const { createDocumentRouter } = await import('../document.js')
await import('../../sync-audience.js')

function updateOf(edit: (doc: LoroDoc) => void): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const from = doc.version()
  edit(doc)
  doc.commit()
  return doc.export({ mode: 'update', from }) as Uint8Array<ArrayBuffer>
}

describe('GET /versions/:id/document over a version holding a retired shape', () => {
  it('is refused, as an unhandled error, and a plain version still previews', async () => {
    const app = createDocumentRouter(
      testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }),
    )
    await writeDocumentUpdate(
      serverDeps,
      WS,
      'canvas-a',
      updateOf((doc) =>
        writeSpatialCanvas(doc, {
          nodes: [textNode({ id: 'n1', text: 'n1', x: 0, y: 0, width: 10, height: 10 })],
          edges: [],
        }),
      ),
    )
    const documentId = await documentIdAt(serverDeps, WS, 'canvas-a')
    const save = (label: string) =>
      app.request(`/api/workspaces/${WS}/documents/${documentId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
    const plain = ((await (await save('plain')).json()) as { version: { id: string } }).version
    await writeDocumentUpdate(
      serverDeps,
      WS,
      'canvas-a',
      updateOf((doc) => {
        doc.getMap('nodes').set('old', { id: 'old', 'x-whiteboard': { a: 1 } })
      }),
    )
    const old = ((await (await save('retired')).json()) as { version: { id: string } }).version

    const preview = (id: string) =>
      app.request(`/api/workspaces/${WS}/documents/${documentId}/versions/${id}/document`)
    const ok = await preview(plain.id)
    expect(ok.status).toBe(200)
    const refused = await preview(old.id)
    expect(refused.status).toBe(500)
  })
})
