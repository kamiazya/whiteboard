/**
 * The trash surface: what a delete evacuated, listed and restorable.
 *
 * The machinery (evacuate-before-remove, restore-as-copy under the SAME
 * documentId) lives in workspace-index and is conformance-tested there; what
 * this file pins is the REACH — the HTTP adapter a human's Restore button
 * calls, end to end through the real container deps and the real delete
 * route.
 */
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listTrashResponseSchema,
  restoreTrashResponseSchema,
} from '../../../shared/api-contracts/document.js'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-trash-test-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, resolveDocumentIdAtPath } = await import('../../store/document-store.js')
const { clearCache } = await import('../../store/doc-cache.js')
const { createDocumentRouter } = await import('../document.js')
const { createContainer, resolveServerDeps } = await import('../../../di/container.js')
const { createStoreLocalModule } = await import('../../../di/store-local.module.js')
const { prepareDataDir } = await import('../../store/db/prepare.js')
const { getDb } = await import('../../store/db/index.js')

beforeEach(() => {
  clearCache()
})

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
  return doc
}

async function appWithRealDeps() {
  await prepareDataDir(tmp.dir)
  const db = await getDb(tmp.dir)
  const deps = resolveServerDeps(createContainer(createStoreLocalModule({ db, blobDir: tmp.dir })))
  return createDocumentRouter({ serverDeps: deps })
}

describe('trash routes', () => {
  it('a deleted document is listed in the trash and restore brings it back under the SAME documentId', async () => {
    const WS = 'ws-trash'
    await saveDocument(WS, 'keep', canvasDoc('kept'), { kind: 'spatial' })
    await saveDocument(WS, 'doomed', canvasDoc('to delete'), { kind: 'spatial' })
    const documentId = await resolveDocumentIdAtPath(WS, 'doomed')
    expect(documentId).not.toBeNull()
    const app = await appWithRealDeps()

    const del = await app.request(`/api/workspaces/${WS}/documents/doomed`, { method: 'DELETE' })
    expect(del.status).toBe(200)

    const listed = await app.request(`/api/workspaces/${WS}/trash`)
    expect(listed.status).toBe(200)
    const body = listTrashResponseSchema.parse(await listed.json())
    expect(body.entries.map((entry) => entry.documentId)).toEqual([documentId])
    expect(body.entries[0]?.path).toBe('doomed')
    expect(body.entries[0]?.deletedAt).toBeGreaterThan(0)

    const restored = await app.request(`/api/workspaces/${WS}/trash/${documentId}/restore`, {
      method: 'POST',
    })
    expect(restored.status).toBe(200)
    const restoredBody = restoreTrashResponseSchema.parse(await restored.json())
    expect(restoredBody.restored.documentId).toBe(documentId)
    expect(restoredBody.restored.path).toBe('doomed')

    // The identity survives: the old address resolves to the old document.
    expect(await resolveDocumentIdAtPath(WS, 'doomed')).toBe(documentId)
    // And the trash no longer lists it.
    const after = listTrashResponseSchema.parse(
      await (await app.request(`/api/workspaces/${WS}/trash`)).json(),
    )
    expect(after.entries).toEqual([])
  })

  it('unknown workspace answers 404 on list; unknown documentId answers 404 on restore', async () => {
    const WS = 'ws-trash-missing'
    await saveDocument(WS, 'doc', canvasDoc('content'), { kind: 'spatial' })
    const app = await appWithRealDeps()

    expect((await app.request('/api/workspaces/ws-nowhere/trash')).status).toBe(404)
    expect(
      (
        await app.request(`/api/workspaces/${WS}/trash/01ARZ3NDEKTSV4RRFFQ69G5FAV/restore`, {
          method: 'POST',
        })
      ).status,
    ).toBe(404)
  })
})
