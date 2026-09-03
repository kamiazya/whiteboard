/**
 * The live-doc routes operate through the ServerDeps they were given.
 *
 * `serverDeps` is an OPTIONAL router option, so a wiring bug — the field
 * declared but never read, or document.ts forgetting to pass it on — compiles
 * clean and passes every test that exercises only the getDefaultServerDeps
 * fallback, which is all of live-doc.test.ts. Same bug class
 * handle-resolution-seam.test.ts pins for handle resolution: the recorder on
 * the INJECTED deps is what tells "went through the seam" apart from "went
 * around it to module-level state", because both persist the same bytes.
 */
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-live-doc-seam-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { getDefaultServerDeps } = await import('../../../di/default-server-deps.js')
const { createDocumentRouter } = await import('../document.js')
// Pre-load ws.js, mirroring the other route tests' documented cycle
// workaround for document.ts's dynamic import.
await import('../ws.js')

function updateBytes(nodeIds: readonly string[]): Uint8Array {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: nodeIds.map((id) => ({
      id,
      type: 'text' as const,
      text: id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })),
    edges: [],
  })
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array
}

describe('live-doc routes and the deps they were handed', () => {
  it('POST /update reads and writes through the INJECTED liveDocuments', async () => {
    const deps = await getDefaultServerDeps()
    const recorded: string[] = []
    const real = deps.liveDocuments
    deps.liveDocuments = {
      ...real,
      get: async (workspaceId, path) => {
        recorded.push(`get ${workspaceId}/${path}`)
        return real.get(workspaceId, path)
      },
      save: async (workspaceId, path, doc, options) => {
        recorded.push(`save ${workspaceId}/${path}`)
        return real.save(workspaceId, path, doc, options)
      },
    }

    const app = createDocumentRouter({ serverDeps: deps, autoVersionQuietMs: 60_000 })
    const res = await app.request('/api/w/seam-ws/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: updateBytes(['n1']),
    })

    expect(res.status).toBe(200)
    // The recorder on the injected deps is the discriminator: a route that
    // went around the seam to module-level stores persists the same bytes
    // and leaves this empty.
    expect(recorded).toEqual(['get seam-ws/canvas-a', 'save seam-ws/canvas-a'])
  })
})
