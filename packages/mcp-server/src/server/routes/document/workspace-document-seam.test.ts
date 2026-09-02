/**
 * The workspace-document routes operate through the ServerDeps they were
 * given — the same optional-serverDeps-threading bug class live-doc-seam
 * and handle-resolution-seam pin, proven twice now: a declared-but-unread
 * `serverDeps` field compiles clean and passes every fallback-path test.
 */
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-workspace-doc-seam-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { getDefaultServerDeps } = await import('../../../di/default-server-deps.js')
const { seedWorkspaceRow } = await import('../_test-helpers.js')
const { createDocumentRouter } = await import('../document.js')
// Pre-load ws.js, mirroring the other route tests' documented cycle
// workaround for document.ts's dynamic import.
await import('../ws.js')

const WS = 'seam-ws'

function workspaceUpdateBytes(path: string): Uint8Array {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  createWorkspaceDocumentAtPath(doc, { path, documentId: generateDocumentId(), kind: 'spatial' })
  doc.commit()
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array
}

describe('workspace-document routes and the deps they were handed', () => {
  it('POST /update reads and writes through the INJECTED workspaceDocuments', async () => {
    await seedWorkspaceRow(tmp.dir, WS)
    const deps = await getDefaultServerDeps()
    const recorded: string[] = []
    const real = deps.workspaceDocuments
    deps.workspaceDocuments = {
      ...real,
      get: async (workspaceId) => {
        recorded.push(`get ${workspaceId}`)
        return real.get(workspaceId)
      },
      save: async (workspaceId, doc) => {
        recorded.push(`save ${workspaceId}`)
        return real.save(workspaceId, doc)
      },
    }

    const app = createDocumentRouter({ serverDeps: deps, autoVersionIntervalMs: 60_000 })
    const res = await app.request(`/api/w/${WS}/workspace-document/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: workspaceUpdateBytes('canvas-a'),
    })

    expect(res.status).toBe(200)
    // The recorder on the injected deps is the discriminator: a route that
    // went around the seam to module-level stores persists the same bytes
    // and leaves this empty.
    expect(recorded).toEqual([`get ${WS}`, `save ${WS}`])
  })
})
