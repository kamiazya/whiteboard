/**
 * The composition root's dual-plane wiring: the agent tool surface
 * (`deps.documentStore` with `document:` refs, `deps.documentIndex`) and the
 * daemon's own route store must see ONE document, not a per-plane copy — an
 * agent edit the web app cannot see, or vice versa, is silent divergence.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  documentContainers,
  readSpatialCanvas,
  readTrashEntries,
  resolveWorkspaceDocumentById,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
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

const { saveDocument, loadDocument } = await import('./document-store.js')
const { WorkspaceRoutedDocumentStore, DualPlaneDocumentIndex } = await import(
  './workspace-plane.js'
)
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
const { SqliteDocumentIndex } = await import('./sqlite-document-index.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-plane-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
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

function readText(doc: LoroDoc): string | null {
  const node = readSpatialCanvas(doc).nodes[0]
  return node?.type === 'text' ? node.text : null
}

async function stores() {
  const db = await getDb(tempDir)
  const inner = new LibsqlDocumentStore(db)
  return {
    db,
    inner,
    routed: new WorkspaceRoutedDocumentStore(inner, db),
    index: new DualPlaneDocumentIndex(new SqliteDocumentIndex(db), db),
  }
}

it('a tool read (document ref) sees a daemon-route write, and a tool write lands on the tree', async () => {
  const { db, inner, routed } = await stores()
  await saveDocument('ws-a', 'design', canvasDoc('route-written'), { kind: 'spatial' })
  const row = await db
    .selectFrom('documents')
    .select(['id'])
    .where('path', '=', 'design')
    .executeTakeFirstOrThrow()

  // Tool read: the same content the route wrote.
  const loaded = await routed.loadSnapshot({ docRef: { kind: 'document', documentId: row.id } })
  expect(loaded).not.toBeNull()
  if (loaded === null) return
  const toolDoc = new LoroDoc()
  toolDoc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
  expect(readText(toolDoc)).toBe('route-written')

  // Tool write: edits go back to the tree, where the route reads them.
  writeSpatialCanvas(toolDoc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'tool-edited' }],
    edges: [],
  })
  const { manifest, chunks } = chunkSnapshot(
    new Uint8Array(toolDoc.export({ mode: 'snapshot' })),
    1_000_000,
  )
  await routed.saveSnapshot({
    docRef: { kind: 'document', documentId: row.id },
    manifest,
    chunks,
    frontier: new Uint8Array(toolDoc.oplogVersion().encode()),
  })
  expect(readText(await loadDocument('ws-a', 'design'))).toBe('tool-edited')
  // Still nothing on the legacy per-document plane.
  expect(await inner.loadSnapshot({ docRef: { kind: 'document', documentId: row.id } })).toBeNull()
})

it('readFrontier answers for a tree-served document, and the stamp moves when its content does', async () => {
  // ContentFactsCache (search / backlinks / tags) validates every cached
  // fact by this frontier. The legacy per-document record it used to read
  // is retired, so a null here silently blanks the whole search corpus —
  // the exact shape `pnpm smoke:e2e`'s wb_document_search step caught.
  const { routed } = await stores()
  await saveDocument('ws-a', 'design', canvasDoc('v1'), { kind: 'spatial' })
  const { db } = await stores()
  const row = await db
    .selectFrom('documents')
    .select(['id'])
    .where('path', '=', 'design')
    .executeTakeFirstOrThrow()

  const before = await routed.readFrontier({ docRef: { kind: 'document', documentId: row.id } })
  expect(before).not.toBeNull()
  if (before === null) return

  await saveDocument('ws-a', 'design', canvasDoc('v2'), { kind: 'spatial', overwrite: true })
  const after = await routed.readFrontier({ docRef: { kind: 'document', documentId: row.id } })
  expect(after).not.toBeNull()
  if (after === null) return
  expect(Buffer.from(after.frontier).equals(Buffer.from(before.frontier))).toBe(false)
})

it('workspace-tree refs pass straight through to the inner store', async () => {
  const { inner, routed } = await stores()
  const ws = new LoroDoc()
  ws.getMap('probe').set('k', 'v')
  ws.commit()
  const docs = new DocumentStoreWorkspaceDocs(routed)
  await docs.save('ws-pass', ws)
  const reopened = await new DocumentStoreWorkspaceDocs(inner).open('ws-pass')
  expect(reopened).not.toBeNull()
})

it('the dual-plane index creates, renames and deletes on BOTH planes', async () => {
  const { db, index } = await stores()
  await index.createWorkspace({ workspaceId: 'ws-a' })
  const entry = await index.createDocument({
    workspaceId: 'ws-a',
    path: 'twin',
    kind: 'spatial',
    name: 'Twin',
  })

  const openTree = async () =>
    new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).open('ws-a')

  let tree = await openTree()
  expect(tree).not.toBeNull()
  if (tree === null) return
  expect(resolveWorkspaceDocumentById(tree, entry.documentId)?.path).toBe('twin')
  expect(resolveWorkspaceDocumentById(tree, entry.documentId)?.name).toBe('Twin')

  await index.setDocumentName({
    workspaceId: 'ws-a',
    documentId: entry.documentId,
    name: 'Renamed twin',
  })
  await index.moveDocument({ workspaceId: 'ws-a', from: 'twin', to: 'moved/twin' })
  tree = await openTree()
  expect(tree).not.toBeNull()
  if (tree === null) return
  const moved = resolveWorkspaceDocumentById(tree, entry.documentId)
  expect(moved?.path).toBe('moved/twin')
  expect(moved?.name).toBe('Renamed twin')

  // Content survives placement changes, and delete evacuates it.
  writeSpatialCanvas(documentContainers(tree, entry.documentId), {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'evacuate me' }],
    edges: [],
  })
  await new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).save('ws-a', tree)

  await index.deleteDocument({ workspaceId: 'ws-a', path: 'moved/twin' })
  tree = await openTree()
  expect(tree).not.toBeNull()
  if (tree === null) return
  expect(resolveWorkspaceDocumentById(tree, entry.documentId)).toBeNull()
  expect(readTrashEntries(tree).map((t) => t.documentId)).toContain(entry.documentId)
  expect(
    await db
      .selectFrom('documents')
      .select(['id'])
      .where('id', '=', entry.documentId)
      .executeTakeFirst(),
  ).toBeUndefined()
})
