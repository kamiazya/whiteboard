/**
 * The live-doc routes operate through the ServerDeps they were given.
 *
 * `serverDeps` is required now, but a wiring bug — the field read for one
 * route and module-level state reached for another — still compiles clean
 * and passes every test that persists the same bytes either way, which is
 * all of live-doc.test.ts. Same bug class handle-resolution-seam.test.ts
 * pins for handle resolution: the recorder on the INJECTED deps is what
 * tells "went through the seam" apart from "went around it".
 */

import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { testDocumentRouterOptions, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-live-doc-seam-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { documentIdAt, resolveTestServerDeps, writeDocumentUpdate } = await import(
  '../_test-helpers.js'
)
const { createDocumentRouter } = await import('../document.js')
// Pre-load ws.js, mirroring the other route tests' documented cycle
// workaround for document.ts's dynamic import.
await import('../../sync-audience.js')

function updateBytes(nodeIds: readonly string[]): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: nodeIds.map((id) => textNode({ id, text: id, x: 0, y: 0, width: 10, height: 10 })),
    edges: [],
  })
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array<ArrayBuffer>
}

describe('live-doc routes and the deps they were handed', () => {
  it('GET /snapshot reads through the INJECTED liveDocuments', async () => {
    const deps = await resolveTestServerDeps(tmp.dir)
    await deps.documentIndex.createWorkspace({ workspaceId: '01FCF6YZ7AZ4K20T4QCA9JJ9QM' })
    const real = deps.liveDocuments
    await writeDocumentUpdate(deps, '01FCF6YZ7AZ4K20T4QCA9JJ9QM', 'canvas-a', updateBytes(['n1']))
    const recorded: string[] = []
    deps.liveDocuments = {
      ...real,
      exists: async (workspaceId, path) => {
        recorded.push(`exists ${workspaceId}/${path}`)
        return real.exists(workspaceId, path)
      },
      get: async (workspaceId, path) => {
        recorded.push(`get ${workspaceId}/${path}`)
        return real.get(workspaceId, path)
      },
    }

    const app = createDocumentRouter(
      testDocumentRouterOptions({
        serverDeps: deps,
        autoVersionQuietMs: 60_000,
      }),
    )
    const documentId = await documentIdAt(deps, '01FCF6YZ7AZ4K20T4QCA9JJ9QM', 'canvas-a')
    const res = await app.request(
      `/api/workspaces/01FCF6YZ7AZ4K20T4QCA9JJ9QM/documents/${documentId}/snapshot`,
    )

    expect(res.status).toBe(200)
    // The recorder on the injected deps is the discriminator: a route that
    // went around the seam to module-level stores answers the same bytes
    // and leaves this empty.
    expect(recorded).toEqual([
      'exists 01FCF6YZ7AZ4K20T4QCA9JJ9QM/canvas-a',
      'get 01FCF6YZ7AZ4K20T4QCA9JJ9QM/canvas-a',
    ])
  })
})
