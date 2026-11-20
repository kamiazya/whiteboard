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

const WS = '0116NJGHSB3ANHRZ893HW4SJQH'
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
  it('signals each edited document for its checkpoint, cutting no copy of any', async () => {
    let projectionsCut = 0
    const workspaceDocuments = {
      ...serverDeps.workspaceDocuments,
      withRecord: serverDeps.workspaceDocuments.withRecord.bind(serverDeps.workspaceDocuments),
    }
    const realWithRecord = workspaceDocuments.withRecord
    workspaceDocuments.withRecord = (workspaceId, fn) =>
      realWithRecord(workspaceId, (record) =>
        fn({
          ...record,
          exportProjection: (documentId) => {
            projectionsCut += 1
            return record.exportProjection(documentId)
          },
        }),
      )
    const signalled: { path: string; frontier: () => Promise<Uint8Array> }[] = []
    const app = createWorkspaceDocumentRouter({
      serverDeps: { ...serverDeps, workspaceDocuments },
      mayPlaceDocuments: () => true,
      triggerAutoVersion: (_workspaceId, path, frontier) => {
        signalled.push({ path, frontier })
      },
    })

    const res = await app.request(`/api/w/${WS}/workspace-document/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(updateCreating(EDITED)),
    })

    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(signalled).toHaveLength(EDITED))
    expect(new Set(signalled.map((each) => each.path)).size).toBe(EDITED)
    expect(projectionsCut).toBe(0)
    // What each checkpoint would stand at is the record's stored frontier, read when it is asked.
    const stored = await serverDeps.documentStore.readFrontier({
      docRef: { kind: 'workspace-tree', workspaceId: WS },
    })
    for (const { frontier } of signalled) {
      expect(await frontier()).toEqual(stored?.frontier)
    }
  })
})
