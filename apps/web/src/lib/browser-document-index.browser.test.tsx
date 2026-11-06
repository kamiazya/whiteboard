/**
 * The PRODUCTION browser index composition (App.tsx's): the workspace-tree
 * index with the keeper's registry, capacity and refusal around it, with
 * content seeded into and read back from the tree — real IndexedDB, because
 * that is what it composes over.
 */

import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_NAME_MAX_LENGTH, generateDocumentId, nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
import {
  seedTreeContent,
  seedWorkspaceDocumentContent,
} from '../test-utils/seed-workspace-content.js'
import { BrowserDocumentIndex } from './browser-document-index.js'
import { WorkspaceCapacityReachedError } from './browser-keeper-capacity.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { LoroStore } from './loro-store.js'
import { loadDocumentContent } from './workspace-content.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('browser-document-index')

function canvasWith(text: string) {
  return {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  }
}

describe('BrowserDocumentIndex (tree-backed composition)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  it('refuses a workspace that still holds pre-tree records, never listing it as empty', async () => {
    const workspaceId = getBrowserWorkspaceId()
    await seedLegacyRow({ workspaceId, path: 'from-before', kind: 'spatial' })
    const index = new BrowserDocumentIndex()
    const refusal = { name: 'BrowserStorageRefusedError', reason: 'pre-tree-records' }
    await expect(index.listDocuments({ workspaceId })).rejects.toMatchObject(refusal)
    await expect(index.resolveDocument({ workspaceId, path: 'from-before' })).rejects.toMatchObject(
      refusal,
    )
    await expect(
      index.createDocument({ workspaceId, path: 'new-one', kind: 'spatial' }),
    ).rejects.toMatchObject(refusal)
  })

  it('refuses only the workspace holding pre-tree records; a new one works beside it', async () => {
    await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'from-before',
      kind: 'spatial',
    })
    const index = new BrowserDocumentIndex()
    const fresh = generateDocumentId()
    await index.createWorkspace({ workspaceId: fresh, segment: 'fresh' })
    await index.createDocument({ workspaceId: fresh, path: 'plan', kind: 'markdown' })
    expect((await index.listDocuments({ workspaceId: fresh })).map((e) => e.path)).toEqual(['plan'])
    expect((await index.listWorkspaces()).map((w) => w.workspaceId)).toContain(fresh)
  })

  it('delete evacuates into the trash; restore brings the document back under the same id', async () => {
    const index = new BrowserDocumentIndex()
    await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'doomed',
      kind: 'spatial',
      name: 'Doomed',
    })
    const source = new Loro()
    writeSpatialCanvas(source, canvasWith('to bring back'))
    await seedWorkspaceDocumentContent(entry.documentId, source.export({ mode: 'snapshot' }))

    await index.deleteDocument({ workspaceId: getBrowserWorkspaceId(), path: 'doomed' })
    const trash = await index.listTrash({ workspaceId: getBrowserWorkspaceId() })
    expect(trash.map((row) => row.documentId)).toEqual([entry.documentId])
    expect(trash[0]?.path).toBe('doomed')

    const restored = await index.restoreDocument({
      workspaceId: getBrowserWorkspaceId(),
      documentId: entry.documentId,
    })
    expect(restored?.documentId).toBe(entry.documentId)
    // Identity survives: the id resolves again, at the old path, with content.
    const back = await index.resolveDocumentById({
      workspaceId: getBrowserWorkspaceId(),
      documentId: entry.documentId,
    })
    expect(back?.path).toBe('doomed')
    const content = await loadDocumentContent(entry.documentId)
    const node = content === null ? null : readSpatialCanvas(content).nodes[0]
    expect(node === null || node === undefined ? null : nodeText(node)).toBe('to bring back')
    expect(await index.listTrash({ workspaceId: getBrowserWorkspaceId() })).toEqual([])
  })

  it('create, seed, rename and delete all round-trip through the tree', async () => {
    const index = new BrowserDocumentIndex()
    await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'fresh',
      kind: 'spatial',
    })

    // The seed path createSeededDocument takes for a duplicate's content.
    const source = new Loro()
    writeSpatialCanvas(source, canvasWith('seeded'))
    await seedTreeContent(entry.documentId, source.export({ mode: 'snapshot' }))
    const content = await loadDocumentContent(entry.documentId)
    const node = content === null ? null : readSpatialCanvas(content).nodes[0]
    expect(node === null || node === undefined ? null : nodeText(node)).toBe('seeded')
    // Nothing legacy was written: the tree node IS the content record.
    expect((await new LoroStore().load(entry.documentId)).kind).toBe('not-found')

    await index.setDocumentName({
      workspaceId: getBrowserWorkspaceId(),
      documentId: entry.documentId,
      name: 'Renamed',
    })
    const renamed = await index.resolveDocumentById({
      workspaceId: getBrowserWorkspaceId(),
      documentId: entry.documentId,
    })
    expect(renamed?.name).toBe('Renamed')

    await index.deleteDocument({ workspaceId: getBrowserWorkspaceId(), path: 'fresh' })
    expect(await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })).toEqual([])
    // Deleted from the tree means unreadable through the content path too.
    expect(await loadDocumentContent(entry.documentId)).toBeNull()
  })

  it('refuses a document name past the declared bound and keeps the old one', async () => {
    const index = new BrowserDocumentIndex()
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'named',
      kind: 'spatial',
    })
    await index.setDocumentName({ workspaceId, documentId, name: 'Kept' })

    await expect(
      index.setDocumentName({
        workspaceId,
        documentId,
        name: 'x'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow(/at most 200 characters/)
    expect((await index.resolveDocumentById({ workspaceId, documentId }))?.name).toBe('Kept')
  })

  it('refuses a document past the declared capacity, and takes one again once there is room', async () => {
    const index = new BrowserDocumentIndex(undefined, { capacity: { bandStartsAt: 1, limit: 2 } })
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    await index.createDocument({ workspaceId, path: 'a', kind: 'markdown' })
    await index.createDocument({ workspaceId, path: 'b', kind: 'markdown' })

    await expect(
      index.createDocument({ workspaceId, path: 'c', kind: 'markdown' }),
    ).rejects.toBeInstanceOf(WorkspaceCapacityReachedError)
    // Refusing adds nothing, and leaves what is there readable.
    expect((await index.listDocuments({ workspaceId })).map((e) => e.path)).toEqual(['a', 'b'])

    await index.deleteDocument({ workspaceId, path: 'a' })
    await expect(
      index.createDocument({ workspaceId, path: 'c', kind: 'markdown' }),
    ).resolves.toMatchObject({ path: 'c' })
  })

  it('refuses to duplicate into a full workspace, and makes no copy', async () => {
    const index = new BrowserDocumentIndex(undefined, { capacity: { bandStartsAt: 1, limit: 2 } })
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    await index.createDocument({ workspaceId, path: 'a', kind: 'markdown' })
    await index.createDocument({ workspaceId, path: 'b', kind: 'markdown' })

    await expect(index.duplicateDocument({ workspaceId, path: 'a' })).rejects.toBeInstanceOf(
      WorkspaceCapacityReachedError,
    )
    expect((await index.listDocuments({ workspaceId })).map((e) => e.path)).toEqual(['a', 'b'])
  })

  it('refuses to restore from the trash into a full workspace', async () => {
    const index = new BrowserDocumentIndex(undefined, { capacity: { bandStartsAt: 1, limit: 2 } })
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const trashed = await index.createDocument({ workspaceId, path: 'a', kind: 'markdown' })
    await index.createDocument({ workspaceId, path: 'b', kind: 'markdown' })
    await index.deleteDocument({ workspaceId, path: 'a' })
    await index.createDocument({ workspaceId, path: 'c', kind: 'markdown' })

    await expect(
      index.restoreDocument({ workspaceId, documentId: trashed.documentId }),
    ).rejects.toBeInstanceOf(WorkspaceCapacityReachedError)
    // Still in the trash, not lost: it can come back once there is room.
    expect((await index.listTrash({ workspaceId })).map((row) => row.documentId)).toEqual([
      trashed.documentId,
    ])
  })
})
