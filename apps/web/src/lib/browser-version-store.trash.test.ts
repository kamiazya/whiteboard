/**
 * What deleting a document does to its saved versions in the browser keeper.
 *
 * The delete confirmation's copy depends on the answer: a delete evacuates
 * the document into the Trash and removes nothing from the `versions` store,
 * and a restore brings the document back under the same documentId those rows
 * are keyed by. The browser's copy says "restore it" and promises nothing
 * about versions being lost, which is only honest while this holds.
 *
 * The rows are read raw, not through `BrowserVersionStore.list`: fake-indexeddb
 * clones a row's `Uint8Array` frontiers into jsdom's realm, where the store's
 * `z.instanceof(Uint8Array)` skips the row. The store's own reads are pinned
 * against real IndexedDB in browser-version-store.browser.test.tsx.
 */

// jsdom + fake-indexeddb: this is IndexedDB persistence logic, not browser layout.
import 'fake-indexeddb/auto'
import {
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { VERSIONS_STORE, whiteboardDbName } from './browser-idb.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { inTransaction, request } from './idb-tx.js'

claimIsolatedWhiteboardDb('browserversiontrash')

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  })
  doc.commit()
  return doc
}

async function versionRows(): Promise<{ id: string; documentId: string }[]> {
  const rows = await inTransaction(whiteboardDbName(), [VERSIONS_STORE], 'readonly', (tx) =>
    request(tx.objectStore(VERSIONS_STORE).getAll()),
  )
  return rows as { id: string; documentId: string }[]
}

describe('a browser document delete and its saved versions', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  it('keeps the version rows through the delete and rejoins them on a restore from the Trash', async () => {
    const index = new FoldingBrowserIndex()
    const docs = new BrowserWorkspaceDocs()
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'canvas-a',
      kind: 'spatial',
    })
    const record = await docs.open(workspaceId)
    if (record === null) throw new Error('no record')
    writeWorkspaceDocumentContent(record, documentId, canvasDoc('kept'))
    await docs.save(workspaceId, record)
    const saved = await new BrowserVersionStore({ docs, index }).save(workspaceId, 'canvas-a', {
      label: 'before delete',
    })

    await index.deleteDocument({ workspaceId, path: 'canvas-a' })
    expect(await versionRows()).toEqual([expect.objectContaining({ id: saved.id, documentId })])

    const restored = await index.restoreDocument({ workspaceId, documentId })
    expect(restored?.documentId).toBe(documentId)
    expect(await versionRows()).toEqual([expect.objectContaining({ id: saved.id, documentId })])
  })

  it("drops the version rows with a purge from the Trash, and only that document's", async () => {
    const index = new FoldingBrowserIndex()
    const docs = new BrowserWorkspaceDocs()
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const ids: Record<string, string> = {}
    for (const path of ['purged', 'kept']) {
      const { documentId } = await index.createDocument({ workspaceId, path, kind: 'spatial' })
      ids[path] = documentId
      const record = await docs.open(workspaceId)
      if (record === null) throw new Error('no record')
      writeWorkspaceDocumentContent(record, documentId, canvasDoc(path))
      await docs.save(workspaceId, record)
      await new BrowserVersionStore({ docs, index }).save(workspaceId, path, { label: path })
    }
    await index.deleteDocument({ workspaceId, path: 'purged' })

    expect(await index.purgeTrashEntry({ workspaceId, documentId: ids.purged ?? '' })).toBe(true)

    expect((await versionRows()).map((row) => row.documentId)).toEqual([ids.kept])
  })

  it('keeps the version rows when the purge finds nothing in the Trash', async () => {
    const index = new FoldingBrowserIndex()
    const docs = new BrowserWorkspaceDocs()
    const workspaceId = getBrowserWorkspaceId()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'live',
      kind: 'spatial',
    })
    const record = await docs.open(workspaceId)
    if (record === null) throw new Error('no record')
    writeWorkspaceDocumentContent(record, documentId, canvasDoc('live'))
    await docs.save(workspaceId, record)
    await new BrowserVersionStore({ docs, index }).save(workspaceId, 'live')

    expect(await index.purgeTrashEntry({ workspaceId, documentId })).toBe(false)

    expect((await versionRows()).map((row) => row.documentId)).toEqual([documentId])
  })
})
