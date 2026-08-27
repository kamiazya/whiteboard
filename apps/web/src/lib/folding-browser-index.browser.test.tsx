/**
 * The PRODUCTION browser index composition (App.tsx's): the workspace-tree
 * index behind the startup fold, with content seeded into and read back from
 * the tree. The page suites inject the legacy IdbDocumentIndex to keep the
 * fold path covered; this file is where the tree-backed composition itself
 * is pinned — real IndexedDB, because that is what it composes over.
 */
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { DOCUMENT_INDEX_STORE } from './browser-idb.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { inTransaction, request } from './idb-tx.js'
import { BROWSER_WORKSPACE_ID } from './local-document-summary.js'
import { LoroStore } from './loro-store.js'
import { loadDocumentContent, seedWorkspaceDocumentContent } from './workspace-content.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('folding-browser-index')

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(ISOLATED_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

/** Rewrites a stored index row to the pre-kind shape (no `kind` recorded). */
async function stripKindInPlace(documentId: string): Promise<void> {
  await inTransaction(undefined, [DOCUMENT_INDEX_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(DOCUMENT_INDEX_STORE)
    const rows = (await request(store.getAll())) as { documentId: string; kind?: unknown }[]
    for (const row of rows) {
      if (row.documentId !== documentId) continue
      const { kind: _kind, ...withoutKind } = row
      await request(store.put(withoutKind))
    }
  })
}

function canvasWith(text: string) {
  return {
    nodes: [{ id: 'n1', type: 'text' as const, x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  }
}

describe('FoldingBrowserIndex (tree-backed composition)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  it('lists a legacy per-document record after its startup fold, content included', async () => {
    // Seeded exactly as an older build left it: an index row and a
    // per-document Loro record, no workspace document anywhere.
    const legacyIndex = new IdbDocumentIndex()
    await legacyIndex.createWorkspace({ workspaceId: BROWSER_WORKSPACE_ID })
    const entry = await legacyIndex.createDocument({
      workspaceId: BROWSER_WORKSPACE_ID,
      path: 'from-before',
      kind: 'spatial',
      name: 'From before',
    })
    const doc = new Loro()
    writeSpatialCanvas(doc, canvasWith('legacy content'))
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    const index = new FoldingBrowserIndex()
    const rows = await index.listDocuments({ workspaceId: BROWSER_WORKSPACE_ID })
    expect(rows.map((row) => row.path)).toEqual(['from-before'])
    expect(rows[0]?.name).toBe('From before')

    const content = await loadDocumentContent(entry.documentId)
    expect(content).not.toBeNull()
    const node = content === null ? null : readSpatialCanvas(content).nodes[0]
    expect(node?.type === 'text' ? node.text : null).toBe('legacy content')
  })

  it('a fold-skipped unreadable record stays listed, resolvable and deletable', async () => {
    // The fold leaves a record it cannot read where it is (fold-workspace.ts
    // says so in as many words: "still reported by the old path as
    // damaged-but-present"). This index IS the old path's successor, so the
    // fallback read is what keeps that sentence true — without it the
    // document vanishes from every listing while its bytes sit intact.
    const legacyIndex = new IdbDocumentIndex()
    await legacyIndex.createWorkspace({ workspaceId: BROWSER_WORKSPACE_ID })
    const readable = await legacyIndex.createDocument({
      workspaceId: BROWSER_WORKSPACE_ID,
      path: 'readable',
      kind: 'spatial',
    })
    const readableDoc = new Loro()
    writeSpatialCanvas(readableDoc, canvasWith('fine'))
    await new LoroStore().save(readable.documentId, readableDoc.export({ mode: 'snapshot' }))
    const unreadable = await legacyIndex.createDocument({
      workspaceId: BROWSER_WORKSPACE_ID,
      path: 'unreadable',
      kind: 'spatial',
      name: 'Damaged but present',
    })
    // An envelope from a build this one does not know — LoroStore classifies
    // it, the fold skips it, and the row stays.
    await seedSyncDocument(unreadable.documentId, { raw: { v: 99 } })

    const index = new FoldingBrowserIndex()
    const rows = await index.listDocuments({ workspaceId: BROWSER_WORKSPACE_ID })
    expect(rows.map((row) => row.path)).toEqual(['readable', 'unreadable'])

    const resolved = await index.resolveDocumentById({
      workspaceId: BROWSER_WORKSPACE_ID,
      documentId: unreadable.documentId,
    })
    expect(resolved?.path).toBe('unreadable')
    expect(resolved?.name).toBe('Damaged but present')
    expect(
      await index.resolveDocument({ workspaceId: BROWSER_WORKSPACE_ID, path: 'unreadable' }),
    ).not.toBeNull()

    // Deletable, so a user can clear a damaged document instead of keeping
    // an error screen forever.
    await index.deleteDocument({ workspaceId: BROWSER_WORKSPACE_ID, path: 'unreadable' })
    expect(
      (await index.listDocuments({ workspaceId: BROWSER_WORKSPACE_ID })).map((row) => row.path),
    ).toEqual(['readable'])
  })

  it('a kindless legacy row stays invisible — our own pre-kind data defect', async () => {
    const legacyIndex = new IdbDocumentIndex()
    await legacyIndex.createWorkspace({ workspaceId: BROWSER_WORKSPACE_ID })
    // createDocument requires a kind, so write the row the way the defect
    // actually exists: created, then stripped in place.
    const entry = await legacyIndex.createDocument({
      workspaceId: BROWSER_WORKSPACE_ID,
      path: 'pre-kind',
      kind: 'spatial',
    })
    await stripKindInPlace(entry.documentId)

    const index = new FoldingBrowserIndex()
    expect(await index.listDocuments({ workspaceId: BROWSER_WORKSPACE_ID })).toEqual([])
    expect(
      await index.resolveDocumentById({
        workspaceId: BROWSER_WORKSPACE_ID,
        documentId: entry.documentId,
      }),
    ).toBeNull()
  })

  it('delete evacuates into the trash; restore brings the document back under the same id', async () => {
    const index = new FoldingBrowserIndex()
    await index.createWorkspace({ workspaceId: BROWSER_WORKSPACE_ID })
    const entry = await index.createDocument({
      workspaceId: BROWSER_WORKSPACE_ID,
      path: 'doomed',
      kind: 'spatial',
      name: 'Doomed',
    })
    const source = new Loro()
    writeSpatialCanvas(source, canvasWith('to bring back'))
    await seedWorkspaceDocumentContent(entry.documentId, source.export({ mode: 'snapshot' }))

    await index.deleteDocument({ workspaceId: BROWSER_WORKSPACE_ID, path: 'doomed' })
    const trash = await index.listTrash({ workspaceId: BROWSER_WORKSPACE_ID })
    expect(trash.map((row) => row.documentId)).toEqual([entry.documentId])
    expect(trash[0]?.path).toBe('doomed')

    const restored = await index.restoreDocument({
      workspaceId: BROWSER_WORKSPACE_ID,
      documentId: entry.documentId,
    })
    expect(restored?.documentId).toBe(entry.documentId)
    // Identity survives: the id resolves again, at the old path, with content.
    const back = await index.resolveDocumentById({
      workspaceId: BROWSER_WORKSPACE_ID,
      documentId: entry.documentId,
    })
    expect(back?.path).toBe('doomed')
    const content = await loadDocumentContent(entry.documentId)
    const node = content === null ? null : readSpatialCanvas(content).nodes[0]
    expect(node?.type === 'text' ? node.text : null).toBe('to bring back')
    expect(await index.listTrash({ workspaceId: BROWSER_WORKSPACE_ID })).toEqual([])
  })

  it('create, seed, rename and delete all round-trip through the tree', async () => {
    const index = new FoldingBrowserIndex()
    await index.createWorkspace({ workspaceId: BROWSER_WORKSPACE_ID })
    const entry = await index.createDocument({
      workspaceId: BROWSER_WORKSPACE_ID,
      path: 'fresh',
      kind: 'spatial',
    })

    // The seed path createSeededDocument takes for a duplicate's content.
    const source = new Loro()
    writeSpatialCanvas(source, canvasWith('seeded'))
    expect(
      await seedWorkspaceDocumentContent(entry.documentId, source.export({ mode: 'snapshot' })),
    ).toBe(true)
    const content = await loadDocumentContent(entry.documentId)
    const node = content === null ? null : readSpatialCanvas(content).nodes[0]
    expect(node?.type === 'text' ? node.text : null).toBe('seeded')
    // Nothing legacy was written: the tree node IS the content record.
    expect((await new LoroStore().load(entry.documentId)).kind).toBe('not-found')

    await index.setDocumentName({
      workspaceId: BROWSER_WORKSPACE_ID,
      documentId: entry.documentId,
      name: 'Renamed',
    })
    const renamed = await index.resolveDocumentById({
      workspaceId: BROWSER_WORKSPACE_ID,
      documentId: entry.documentId,
    })
    expect(renamed?.name).toBe('Renamed')

    await index.deleteDocument({ workspaceId: BROWSER_WORKSPACE_ID, path: 'fresh' })
    expect(await index.listDocuments({ workspaceId: BROWSER_WORKSPACE_ID })).toEqual([])
    // Deleted from the tree means unreadable through the content path too.
    expect(await loadDocumentContent(entry.documentId)).toBeNull()
  })
})
