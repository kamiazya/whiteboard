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
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbDocumentIndex } from './idb-document-index.js'
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
