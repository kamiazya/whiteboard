/**
 * Name resolution for embeds reads through the PRODUCTION index — the
 * workspace tree behind the startup fold — so a tree-created document and a
 * pre-collapse legacy record (index row + content, nothing in the tree)
 * both answer with their name. The legacy case is served by the fold, not
 * by a second read path of its own.
 */
import 'fake-indexeddb/auto'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { loadBrowserReference, resetEmbedIndexForTests } from './document-embed-content.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { ensureLocalWorkspace } from './local-document-summary.js'
import { LoroStore } from './loro-store.js'

claimIsolatedWhiteboardDb('document-embed-content')

describe('loadBrowserReference', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    resetEmbedIndexForTests()
  })

  it('resolves the name of a document the workspace tree holds', async () => {
    const index = new FoldingBrowserIndex()
    await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() }).catch(() => {})
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/spec',
      kind: 'markdown',
      name: 'The Spec',
    })

    const source = await loadBrowserReference(entry.documentId)
    expect(source?.name).toBe('The Spec')
  })

  it('resolves the name of a legacy record through the fold, not a second read path', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/old',
      kind: 'markdown',
      name: 'Old Note',
    })
    const doc = new Loro()
    doc.getText('body').insert(0, 'legacy body')
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    const source = await loadBrowserReference(entry.documentId)
    expect(source).toEqual({ documentId: entry.documentId, body: 'legacy body', name: 'Old Note' })
  })

  it('answers a spatial document with its canvas rather than an empty body', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'boards/plan',
      kind: 'spatial',
      name: 'The Plan',
    })
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'plan node' }],
      edges: [],
    }
    const doc = new Loro()
    writeSpatialCanvas(doc, canvas)
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    const source = await loadBrowserReference(entry.documentId)
    expect(source).toEqual({ documentId: entry.documentId, name: 'The Plan', canvas })
  })
})
