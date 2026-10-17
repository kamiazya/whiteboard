/**
 * The checkpoint signal a workspace-document update sends for the documents
 * it edited. An update can edit up to the workspace's whole document ceiling
 * at once, so the signals are taken one document at a time rather than as
 * that many concurrent loads.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTestServerDeps, seedWorkspaceRow, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-ws-doc-fanout-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createWorkspaceDocumentRouter } = await import('./workspace-document.js')

const WS = 'fanout'
const EDITED = 6

let serverDeps: ServerDeps
beforeEach(async () => {
  await seedWorkspaceRow(tmp.dir, WS)
  serverDeps = await resolveTestServerDeps(tmp.dir)
})

/** `n` as a canonical ULID tail. */
const idOf = (n: number) => `01BRWD${String(n).padStart(20, '0')}`

/** One update creating `count` markdown documents, each with a body. */
function updateCreating(count: number): Uint8Array {
  const doc = new LoroDoc()
  for (let i = 0; i < count; i++) {
    createWorkspaceDocumentAtPath(doc, { path: `d${i}`, documentId: idOf(i), kind: 'markdown' })
    writeMarkdownBody(documentContainers(doc, idOf(i)), `body ${i}`)
  }
  doc.commit()
  return doc.export({ mode: 'update' })
}

describe('a workspace-document update that edits many documents', () => {
  it('loads the edited documents for their checkpoints one at a time', async () => {
    let inFlight = 0
    let mostInFlight = 0
    const realGet = serverDeps.liveDocuments.get.bind(serverDeps.liveDocuments)
    const liveDocuments = {
      ...serverDeps.liveDocuments,
      get: async (workspaceId: string, path: string) => {
        inFlight += 1
        mostInFlight = Math.max(mostInFlight, inFlight)
        try {
          return await realGet(workspaceId, path)
        } finally {
          inFlight -= 1
        }
      },
    }
    const signalled: string[] = []
    const app = createWorkspaceDocumentRouter({
      serverDeps: { ...serverDeps, liveDocuments },
      triggerAutoVersion: (_workspaceId, path) => {
        signalled.push(path)
      },
    })

    const res = await app.request(`/api/w/${WS}/workspace-document/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(updateCreating(EDITED)),
    })

    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(signalled).toHaveLength(EDITED))
    expect(new Set(signalled).size).toBe(EDITED)
    expect(mostInFlight).toBe(1)
  })
})
