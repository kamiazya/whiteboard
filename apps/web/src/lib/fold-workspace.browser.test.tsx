/**
 * The startup fold: per-document records become nodes of the workspace
 * document, resumably.
 *
 * Real IndexedDB and real Loro wasm, because the constraint the design is
 * built around — Loro's async import cannot live inside a versionchange
 * transaction — only exists here.
 */

import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readSpatialCanvas,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId, nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { DocumentHasDescendantsError } from '@kamiazya/whiteboard-ports'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { CONTENT_TIMESTAMPS_STORE } from './browser-idb.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { foldWorkspaceDocuments } from './fold-workspace.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { inTransaction, request } from './idb-tx.js'
import { LoroStore } from './loro-store.js'

const DB_NAME = claimIsolatedWhiteboardDb('fold-workspace')

beforeEach(clearWhiteboardDb)
afterEach(() => {
  vi.restoreAllMocks()
})

async function contentTimestamp(documentId: string): Promise<unknown> {
  return inTransaction(DB_NAME, [CONTENT_TIMESTAMPS_STORE], 'readonly', (tx) =>
    request(tx.objectStore(CONTENT_TIMESTAMPS_STORE).get(documentId)),
  )
}

async function seedDocument(path: string, text: string): Promise<string> {
  const index = new IdbDocumentIndex(DB_NAME)
  await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind: 'spatial',
  })
  const doc = new Loro()
  doc.getMap('nodes').set('n1', textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text }))
  doc.commit()
  await new LoroStore(DB_NAME).save(entry.documentId, doc.export({ mode: 'snapshot' }))
  return entry.documentId
}

it('folds every indexed document into the workspace document, content included', async () => {
  const designId = await seedDocument('design', 'from design')
  await seedDocument('archive/notes', 'from notes')

  const report = await foldWorkspaceDocuments(DB_NAME)
  expect(report).toEqual({ folded: 2, skipped: 0 })

  // Read back through a FRESH open — what was persisted, not what was in
  // memory when the fold ran.
  const workspace = await new BrowserWorkspaceDocs(DB_NAME).open(getBrowserWorkspaceId())
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  expect(
    readWorkspaceDocuments(workspace)
      .map((entry) => entry.path)
      .sort(),
  ).toEqual(['archive/notes', 'design'])
  const canvas = readSpatialCanvas(documentContainers(workspace, designId))
  expect(canvas.nodes[0] === undefined ? null : nodeText(canvas.nodes[0])).toBe('from design')
})

it('is idempotent, and picks up documents created between runs', async () => {
  await seedDocument('design', 'first')
  expect((await foldWorkspaceDocuments(DB_NAME)).folded).toBe(1)
  // The re-run finds no pending work: the list is derived from "index rows
  // not in the tree", so what the first run carried over is not work anymore.
  expect((await foldWorkspaceDocuments(DB_NAME)).folded).toBe(0)

  await seedDocument('later', 'second')
  expect((await foldWorkspaceDocuments(DB_NAME)).folded).toBe(1)
})

it('skips an unreadable document rather than folding an empty one', async () => {
  const index = new IdbDocumentIndex(DB_NAME)
  await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: 'damaged',
    kind: 'spatial',
  })
  await new LoroStore(DB_NAME).save(entry.documentId, new Uint8Array([1, 2, 3]))

  const report = await foldWorkspaceDocuments(DB_NAME)
  expect(report).toEqual({ folded: 0, skipped: 1 })

  // Not in the tree: the old record stays the damaged document's home, where
  // the old read path reports it as present-but-unreadable.
  const workspace = await new BrowserWorkspaceDocs(DB_NAME).open(getBrowserWorkspaceId())
  expect(
    workspace === null ? null : resolveWorkspaceDocumentById(workspace, entry.documentId),
  ).toBeNull()
})

it('folds nothing in a browser that never had a workspace', async () => {
  expect(await foldWorkspaceDocuments(DB_NAME)).toEqual({ folded: 0, skipped: 0 })
})

it('skips and keeps a row whose path the tree already holds under another id', async () => {
  const logged = expectLoggedFailures()
  // The tree took the path while the row waited: a create on this build, or
  // a move into a path an earlier skipped run left free.
  const docs = new BrowserWorkspaceDocs(DB_NAME)
  const workspace = await docs.create(getBrowserWorkspaceId())
  const treeId = generateDocumentId()
  createWorkspaceDocumentAtPath(workspace, { path: 'design', documentId: treeId, kind: 'spatial' })
  await docs.save(getBrowserWorkspaceId(), workspace)
  const rowId = await seedDocument('design', 'only copy')

  expect(await foldWorkspaceDocuments(DB_NAME)).toEqual({ folded: 0, skipped: 1 })

  // Nothing of the row's is retired: its record is still the only home of
  // its content, and the row is what lists it.
  const workspaceId = getBrowserWorkspaceId()
  expect(
    await new IdbDocumentIndex(DB_NAME).resolveDocumentById({ workspaceId, documentId: rowId }),
  ).not.toBeNull()
  expect((await new LoroStore(DB_NAME).load(rowId)).kind).toBe('ok')
  const reopened = await new BrowserWorkspaceDocs(DB_NAME).open(workspaceId)
  expect(
    reopened === null ? [] : readWorkspaceDocuments(reopened).map((entry) => entry.documentId),
  ).toEqual([treeId])
  // ...and the index's fold-skipped fallback lists it beside the tree's.
  const listed = await new FoldingBrowserIndex(DB_NAME).listDocuments({ workspaceId })
  expect(listed.map((entry) => entry.documentId).sort()).toEqual([rowId, treeId].sort())
  expect(logged.join('\n')).toContain('[fold-workspace] a legacy document met a taken path')
})

it('a fold-skipped delete retires the record before the row, and the listing clock last', async () => {
  const logged = expectLoggedFailures()
  const index = new IdbDocumentIndex(DB_NAME)
  await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
  const workspaceId = getBrowserWorkspaceId()
  const { documentId } = await index.createDocument({
    workspaceId,
    path: 'damaged',
    kind: 'spatial',
  })
  // Unreadable, so the fold skips it and the legacy row stays its only home.
  await new LoroStore(DB_NAME).save(documentId, new Uint8Array([1, 2, 3]))
  expect(await contentTimestamp(documentId)).toBeTypeOf('string')
  const folding = new FoldingBrowserIndex(DB_NAME)

  // Interrupted after the first step: the row must survive, so the document
  // stays listed and deletable rather than leaving a record nothing names.
  vi.spyOn(LoroStore.prototype, 'retire').mockRejectedValueOnce(new Error('injected'))
  await expect(folding.deleteDocument({ workspaceId, path: 'damaged' })).rejects.toThrow('injected')
  expect(await index.resolveDocumentById({ workspaceId, documentId })).not.toBeNull()

  await folding.deleteDocument({ workspaceId, path: 'damaged' })
  expect(await index.resolveDocumentById({ workspaceId, documentId })).toBeNull()
  expect((await new LoroStore(DB_NAME).load(documentId)).kind).toBe('not-found')
  // No copy is left for the clock to date.
  expect(await contentTimestamp(documentId)).toBeUndefined()
  expect(logged.join('\n')).toContain('startup fold left documents behind')
})

it('a fold retires the row and record and keeps the listing clock of the tree copy', async () => {
  const documentId = await seedDocument('design', 'from design')
  expect((await foldWorkspaceDocuments(DB_NAME)).folded).toBe(1)
  const workspaceId = getBrowserWorkspaceId()
  expect(
    await new IdbDocumentIndex(DB_NAME).resolveDocumentById({ workspaceId, documentId }),
  ).toBeNull()
  expect((await new LoroStore(DB_NAME).load(documentId)).kind).toBe('not-found')
  expect(await contentTimestamp(documentId)).toBeTypeOf('string')
})

it('a fold-skipped delete refuses a parent, as the port does, and retires nothing', async () => {
  const logged = expectLoggedFailures()
  const index = new IdbDocumentIndex(DB_NAME)
  await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
  const workspaceId = getBrowserWorkspaceId()
  const parent = await index.createDocument({ workspaceId, path: 'a', kind: 'spatial' })
  const child = await index.createDocument({ workspaceId, path: 'a/b', kind: 'spatial' })
  for (const { documentId } of [parent, child]) {
    await new LoroStore(DB_NAME).save(documentId, new Uint8Array([1, 2, 3]))
  }

  await expect(
    new FoldingBrowserIndex(DB_NAME).deleteDocument({ workspaceId, path: 'a' }),
  ).rejects.toBeInstanceOf(DocumentHasDescendantsError)
  expect((await new LoroStore(DB_NAME).load(parent.documentId)).kind).toBe('corrupt-snapshot')
  expect(
    await index.resolveDocumentById({ workspaceId, documentId: parent.documentId }),
  ).not.toBeNull()
  expect(logged.join('\n')).toContain('startup fold left documents behind')
})
