/**
 * Name resolution for embeds reads through the PRODUCTION index — the
 * workspace tree behind the startup fold — so a tree-created document and a
 * pre-collapse legacy record (index row + content, nothing in the tree)
 * both answer with their name. The legacy case is served by the fold, not
 * by a second read path of its own.
 */
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import 'fake-indexeddb/auto'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
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

  it('a workspace that could not be OPENED is not a document with no content', async () => {
    // The other half of the same lie: the tree read failed, so the legacy
    // row's "no record here" is the only answer left — and on its own it
    // says nothing, because the place the content actually lives was never
    // reached.
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/tree-only',
      kind: 'markdown',
      name: 'Tree only',
    })
    const unreadableTree = vi
      .spyOn(BrowserWorkspaceDocs.prototype, 'open')
      .mockRejectedValue(new Error('the workspace record could not be opened'))
    try {
      await expect(loadBrowserReference(entry.documentId)).rejects.toThrow(/could not be read/)
      await expectLoggedFailure('referenced document load failed')
    } finally {
      unreadableTree.mockRestore()
    }
  })

  it("re-throws the store's own read-unavailable, which is a RESULT and not a throw", async () => {
    // The shape that matters most, and the one a first pass missed: this
    // store reports a transient read as `{ kind: 'read-unavailable' }` — a
    // variant that exists to say "the read failed and this says nothing
    // about the document" — so a fix that only handled REJECTIONS left the
    // designed signal folded into "no content" exactly as before.
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/unavailable',
      kind: 'markdown',
      name: 'Unavailable',
    })
    const doc = new Loro()
    doc.getText('body').insert(0, 'a body the caller never gets to see')
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))
    const unavailable = vi
      .spyOn(LoroStore.prototype, 'load')
      .mockResolvedValue({ kind: 'read-unavailable' })
    try {
      await expect(loadBrowserReference(entry.documentId)).rejects.toThrow(/could not be read/)
      await expectLoggedFailure('referenced document load failed')
    } finally {
      unavailable.mockRestore()
    }
  })

  it('re-throws a store read that FAILED, rather than answering "no content"', async () => {
    // The two answers are opposite instructions to the prefetch above:
    // `undefined` is the document's own ("nothing here", cached as
    // terminal), a rejection is the database's ("could not read", asked
    // again). Reporting a failed read as the first is what left an embed
    // blank for the life of the page, with nothing logged.
    // A legacy record, so the read under test is the per-document store's:
    // a tree-held document answers from the projection and never reaches it.
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/unreadable',
      kind: 'markdown',
      name: 'Unreadable',
    })
    const doc = new Loro()
    doc.getText('body').insert(0, 'a body the caller never gets to see')
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))
    const failing = vi
      .spyOn(LoroStore.prototype, 'load')
      .mockRejectedValue(new Error('the store could not be read'))
    try {
      await expect(loadBrowserReference(entry.documentId)).rejects.toThrow(
        'the store could not be read',
      )
      await expectLoggedFailure('referenced document load failed')
    } finally {
      failing.mockRestore()
    }
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
      nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 200, height: 100, text: 'plan node' })],
      edges: [],
    }
    const doc = new Loro()
    writeSpatialCanvas(doc, canvas)
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    const source = await loadBrowserReference(entry.documentId)
    expect(source).toEqual({ documentId: entry.documentId, name: 'The Plan', canvas })
  })
})
