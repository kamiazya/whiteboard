/**
 * The daemon document store over the WORKSPACE document: a save writes into
 * the document's tree node (no per-document record and no documents row —
 * the tree IS the address book), loads serve from the tree, and
 * delete/rename operate on the tree alone. A kindless save of a NEW
 * document defaults to spatial: the only kindless saves left are
 * lazy-creates of an empty document, and the spatial editor is what opens
 * them.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  documentContainers,
  readSpatialCanvas,
  readTrashEntries,
  resolveWorkspaceDocument,
  resolveWorkspaceDocumentById,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, loadDocument, deleteDocument, renameDocumentPath } = await import(
  './document-store.js'
)
const { clearCache } = await import('./doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'doc-store-ws-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
  return doc
}

async function openWorkspace(workspaceId: string) {
  const db = await getDb(tempDir)
  return new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).open(workspaceId)
}

async function documentRowCount(): Promise<number> {
  const db = await getDb(tempDir)
  return (await db.selectFrom('documents').select(['id']).execute()).length
}

it('a save with a kind lands on the workspace tree node and writes no per-document record and no row', async () => {
  await saveDocument('ws-a', 'design', canvasDoc('tree-borne'), { kind: 'spatial' })

  const workspace = await openWorkspace('ws-a')
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  const entry = resolveWorkspaceDocument(workspace, 'design')
  expect(entry).not.toBeNull()
  if (entry === null) return
  expect(entry.kind).toBe('spatial')
  const canvas = readSpatialCanvas(documentContainers(workspace, entry.documentId))
  expect(canvas.nodes[0]?.type === 'text' ? canvas.nodes[0].text : null).toBe('tree-borne')

  // The tree is the address book: no documents row, no per-document record.
  expect(await documentRowCount()).toBe(0)
  const db = await getDb(tempDir)
  const store = new LibsqlDocumentStore(db)
  expect(
    await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: 'ws-a', documentId: entry.documentId },
    }),
  ).toBeNull()
})

it('loadDocument serves the tree content back, edits included', async () => {
  await saveDocument('ws-a', 'design', canvasDoc('first'), { kind: 'spatial' })
  const edited = canvasDoc('second')
  await saveDocument('ws-a', 'design', edited, { kind: 'spatial', overwrite: true })

  const loaded = await loadDocument('ws-a', 'design')
  const canvas = readSpatialCanvas(loaded)
  expect(canvas.nodes[0]?.type === 'text' ? canvas.nodes[0].text : null).toBe('second')
})

it('a kindless save of a NEW document lands on the tree as spatial — nothing writes the legacy plane', async () => {
  // The only kindless saves left are lazy-creates of an empty document (the
  // WS/update path on a path with no tree entry); the spatial editor is what
  // opens them, so 'spatial' is the honest default — not a guess about
  // someone else's data, because pre-kind rows no longer exist (the fold
  // deletes them as this project's own data defect).
  await saveDocument('ws-a', 'no-kind', canvasDoc('kindless'))

  const workspace = await openWorkspace('ws-a')
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  const entry = resolveWorkspaceDocument(workspace, 'no-kind')
  expect(entry).not.toBeNull()
  if (entry === null) return
  expect(entry.kind).toBe('spatial')
  expect(await documentRowCount()).toBe(0)
  const db = await getDb(tempDir)
  const store = new LibsqlDocumentStore(db)
  expect(
    await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: 'ws-a', documentId: entry.documentId },
    }),
  ).toBeNull()
  const loaded = await loadDocument('ws-a', 'no-kind')
  const canvas = readSpatialCanvas(loaded)
  expect(canvas.nodes[0]?.type === 'text' ? canvas.nodes[0].text : null).toBe('kindless')
})

it('deleteDocument evacuates the tree node into the trash', async () => {
  await saveDocument('ws-a', 'doomed', canvasDoc('keep a copy'), { kind: 'spatial' })
  const before = await openWorkspace('ws-a')
  expect(before).not.toBeNull()
  if (before === null) return
  const entry = resolveWorkspaceDocument(before, 'doomed')
  expect(entry).not.toBeNull()
  if (entry === null) return

  expect(await deleteDocument('ws-a', 'doomed')).toBe(true)

  const workspace = await openWorkspace('ws-a')
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  expect(resolveWorkspaceDocumentById(workspace, entry.documentId)).toBeNull()
  // Evacuated, not destroyed: the trash records where the bytes went.
  expect(readTrashEntries(workspace).map((t) => t.documentId)).toContain(entry.documentId)
})

it('saving a workspace record registers the workspace — a tool-created workspace must not be invisible to workspaceExists', async () => {
  // The smoke-caught shape: wb_document_create with createWorkspace goes
  // through the tree index and WorkspaceDocs alone (no saveDocument), and a
  // workspace with a stored record but no registry row answers
  // workspaceExists=false — so the WS route refuses the very workspace the
  // tool just created (4404) and the browser never gets a snapshot.
  const { cacheBackedWorkspaceDocs, workspaceExists } = await import('./document-store.js')
  const docs = cacheBackedWorkspaceDocs()
  const record = await docs.create('ws-tool-made')
  await docs.save('ws-tool-made', record)

  expect(await workspaceExists('ws-tool-made')).toBe(true)
})

it('renameDocumentPath moves the tree node', async () => {
  await saveDocument('ws-a', 'old-place', canvasDoc('movable'), { kind: 'spatial' })
  const before = await openWorkspace('ws-a')
  expect(before).not.toBeNull()
  if (before === null) return
  const entry = resolveWorkspaceDocument(before, 'old-place')
  expect(entry).not.toBeNull()
  if (entry === null) return

  await renameDocumentPath('ws-a', 'old-place', 'new-place')

  const workspace = await openWorkspace('ws-a')
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  expect(resolveWorkspaceDocumentById(workspace, entry.documentId)?.path).toBe('new-place')
  const loaded = await loadDocument('ws-a', 'new-place')
  const canvas = readSpatialCanvas(loaded)
  expect(canvas.nodes[0]?.type === 'text' ? canvas.nodes[0].text : null).toBe('movable')
})
