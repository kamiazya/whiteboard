/**
 * The startup fold: per-document records become nodes of the workspace
 * document, resumably.
 *
 * Real IndexedDB and real Loro wasm, because the constraint the design is
 * built around — Loro's async import cannot live inside a versionchange
 * transaction — only exists here.
 */
import {
  documentContainers,
  readSpatialCanvas,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
} from '@kamiazya/whiteboard-loro-adapter'
import { Loro } from 'loro-crdt'
import { beforeEach, expect, it } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { foldWorkspaceDocuments } from './fold-workspace.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { BROWSER_WORKSPACE_ID } from './local-document-summary.js'
import { LoroStore } from './loro-store.js'

const DB_NAME = claimIsolatedWhiteboardDb('fold-workspace')

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

beforeEach(deleteDb)

async function seedDocument(path: string, text: string): Promise<string> {
  const index = new IdbDocumentIndex(DB_NAME)
  await index.createWorkspace({ workspaceId: BROWSER_WORKSPACE_ID })
  const entry = await index.createDocument({
    workspaceId: BROWSER_WORKSPACE_ID,
    path,
    kind: 'spatial',
  })
  const doc = new Loro()
  doc.getMap('nodes').set('n1', { id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text })
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
  const workspace = await new BrowserWorkspaceDocs(DB_NAME).open(BROWSER_WORKSPACE_ID)
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  expect(
    readWorkspaceDocuments(workspace)
      .map((entry) => entry.path)
      .sort(),
  ).toEqual(['archive/notes', 'design'])
  const canvas = readSpatialCanvas(documentContainers(workspace, designId))
  expect(canvas.nodes[0]?.type === 'text' ? canvas.nodes[0].text : null).toBe('from design')
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
  await index.createWorkspace({ workspaceId: BROWSER_WORKSPACE_ID })
  const entry = await index.createDocument({
    workspaceId: BROWSER_WORKSPACE_ID,
    path: 'damaged',
    kind: 'spatial',
  })
  await new LoroStore(DB_NAME).save(entry.documentId, new Uint8Array([1, 2, 3]))

  const report = await foldWorkspaceDocuments(DB_NAME)
  expect(report).toEqual({ folded: 0, skipped: 1 })

  // Not in the tree: the old record stays the damaged document's home, where
  // the old read path reports it as present-but-unreadable.
  const workspace = await new BrowserWorkspaceDocs(DB_NAME).open(BROWSER_WORKSPACE_ID)
  expect(
    workspace === null ? null : resolveWorkspaceDocumentById(workspace, entry.documentId),
  ).toBeNull()
})

it('folds nothing in a browser that never had a workspace', async () => {
  expect(await foldWorkspaceDocuments(DB_NAME)).toEqual({ folded: 0, skipped: 0 })
})
