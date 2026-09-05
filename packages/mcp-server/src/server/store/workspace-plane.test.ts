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
import { describeDocumentStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, loadDocument, cacheBackedWorkspaceDocs, resolveDocumentIdAtPath } =
  await import('./document-store.js')
const { WorkspaceRoutedDocumentStore } = await import('./workspace-plane.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
const { LoroWorkspaceDocumentIndex } = await import('@kamiazya/whiteboard-workspace-index')
const { FsBlobStore } = await import('./fs/fs-blob-store.js')
const { join: joinPath } = await import('node:path')

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
    routed: new WorkspaceRoutedDocumentStore(inner),
    // The production wiring: the tree IS the index (S7), cache-backed so it
    // operates on the same live workspace doc every other path writes.
    index: new LoroWorkspaceDocumentIndex(
      cacheBackedWorkspaceDocs(),
      new FsBlobStore(joinPath(tempDir, 'blobs')),
    ),
  }
}

it('a tool read (document ref) sees a daemon-route write, and a tool write lands on the tree', async () => {
  const { inner, routed } = await stores()
  await saveDocument('ws-a', 'design', canvasDoc('route-written'), { kind: 'spatial' })
  const rowId = await resolveDocumentIdAtPath('ws-a', 'design')
  if (rowId === null) throw new Error('document missing from the tree')
  const row = { id: rowId }

  // Tool read: the same content the route wrote.
  const loaded = await routed.loadSnapshot({
    docRef: { kind: 'document', workspaceId: 'ws-a', documentId: row.id },
  })
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
    docRef: { kind: 'document', workspaceId: 'ws-a', documentId: row.id },
    manifest,
    chunks,
    frontier: new Uint8Array(toolDoc.oplogVersion().encode()),
  })
  expect(readText(await loadDocument('ws-a', 'design'))).toBe('tool-edited')
  // Still nothing on the legacy per-document plane.
  expect(
    await inner.loadSnapshot({
      docRef: { kind: 'document', workspaceId: 'ws-a', documentId: row.id },
    }),
  ).toBeNull()
})

it('readFrontier answers for a tree-served document, and the stamp moves when its content does', async () => {
  // ContentFactsCache (search / backlinks / tags) validates every cached
  // fact by this frontier. The legacy per-document record it used to read
  // is retired, so a null here silently blanks the whole search corpus —
  // the exact shape `pnpm smoke:e2e`'s wb_document_search step caught.
  const { routed } = await stores()
  await saveDocument('ws-a', 'design', canvasDoc('v1'), { kind: 'spatial' })
  const rowId = await resolveDocumentIdAtPath('ws-a', 'design')
  if (rowId === null) throw new Error('document missing from the tree')
  const row = { id: rowId }

  const before = await routed.readFrontier({
    docRef: { kind: 'document', workspaceId: 'ws-a', documentId: row.id },
  })
  expect(before).not.toBeNull()
  if (before === null) return

  await saveDocument('ws-a', 'design', canvasDoc('v2'), { kind: 'spatial', overwrite: true })
  const after = await routed.readFrontier({
    docRef: { kind: 'document', workspaceId: 'ws-a', documentId: row.id },
  })
  expect(after).not.toBeNull()
  if (after === null) return
  expect(Buffer.from(after.frontier).equals(Buffer.from(before.frontier))).toBe(false)
})

it('routes a document ref by ITS OWN workspace, with no documents-table lookup (S6)', async () => {
  // The ref carries the workspace since W3, so the route needs no reverse
  // row lookup — and migration 0017 dropped the documents table outright,
  // so there is no mirror row to fall back to even in principle.
  const { routed } = await stores()
  await saveDocument('ws-a', 'design', canvasDoc('tree-truth'), { kind: 'spatial' })
  const rowId = await resolveDocumentIdAtPath('ws-a', 'design')
  if (rowId === null) throw new Error('document missing from the tree')
  const row = { id: rowId }

  const ref = { kind: 'document', workspaceId: 'ws-a', documentId: row.id } as const
  const loaded = await routed.loadSnapshot({ docRef: ref })
  expect(loaded).not.toBeNull()
  if (loaded === null) return
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
  expect(readText(doc)).toBe('tree-truth')
  expect(await routed.readFrontier({ docRef: ref })).not.toBeNull()
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

it('an index create lists and resolves with NO documents row anywhere (S7)', async () => {
  // The tree is the whole record of what exists: migration 0017 dropped the
  // documents table outright, so there is nothing for a create to write to
  // it even in principle.
  const { index } = await stores()
  await index.createWorkspace({ workspaceId: 'ws-flip' })
  const entry = await index.createDocument({
    workspaceId: 'ws-flip',
    path: 'truth',
    kind: 'spatial',
  })

  const listing = await index.listDocuments({ workspaceId: 'ws-flip' })
  expect(listing.map((e) => e.path)).toEqual(['truth'])
  const resolved = await index.resolveDocument({ workspaceId: 'ws-flip', path: 'truth' })
  expect(resolved?.documentId).toBe(entry.documentId)
})

it('an empty created workspace lists as empty (createWorkspace stores the record)', async () => {
  const { index } = await stores()
  await index.createWorkspace({ workspaceId: 'ws-empty' })
  expect(await index.listDocuments({ workspaceId: 'ws-empty' })).toEqual([])
  expect(await index.resolveDocument({ workspaceId: 'ws-empty', path: 'nope' })).toBeNull()
})

it('the index creates, renames and deletes on the tree', async () => {
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
})

it('does not keep serving an agent write whose persistence failed', async () => {
  // A save mutates the LIVE projection before the record is persisted, so a
  // failure in between leaves every cached reader ahead of durable state and
  // the next read serves content that was never written. `saveWorkspaceDoc`
  // is what prevents that, by evicting both caches in its catch — the choke
  // point every durable workspace write funnels through, which is why this
  // path inherits the guard without repeating it.
  //
  // The guard is load-bearing and was covered ONCE. Mutating that catch to
  // rethrow without evicting turns 4210 mcp-node tests into exactly two
  // failures, and before this test the only one was in `restore.test.ts` —
  // a route-level test of a handler ADR-0018 schedules for removal. So the
  // single guard on an invariant every agent write depends on
  // (`wb_canvas_edit` -> saveDocumentSnapshot -> saveSnapshot) was going to
  // be deleted by an unrelated refactor, silently.
  //
  // Asserted on what a reader GETS, not on whether some cache entry exists,
  // so it keeps meaning the same thing if the caching changes.
  const { routed } = await stores()
  await saveDocument('ws-a', 'design', canvasDoc('persisted'), { kind: 'spatial' })
  const rowId = await resolveDocumentIdAtPath('ws-a', 'design')
  if (rowId === null) throw new Error('document missing from the tree')

  const edited = canvasDoc('never-persisted')
  const { manifest, chunks } = chunkSnapshot(
    new Uint8Array(edited.export({ mode: 'snapshot' })),
    1_000_000,
  )
  const saveSpy = vi
    .spyOn(DocumentStoreWorkspaceDocs.prototype, 'save')
    .mockRejectedValueOnce(new Error('simulated persistence failure'))
  await expect(
    routed.saveSnapshot({
      docRef: { kind: 'document', workspaceId: 'ws-a', documentId: rowId },
      manifest,
      chunks,
      frontier: new Uint8Array(edited.oplogVersion().encode()),
    }),
  ).rejects.toThrow('simulated persistence failure')
  saveSpy.mockRestore()

  expect(readText(await loadDocument('ws-a', 'design'))).toBe('persisted')
})

describe('DocumentStore conformance (production wiring: routed over a tree-backed workspace)', () => {
  // `conformance-ws` is tree-backed (createWorkspace + one seed document at a
  // path the suite never names), but the suite's own DOC/OTHER ids are never
  // placed on that tree. A store's byte-level contract is about opaque
  // records; the tree-served path is a CRDT projection that would import the
  // suite's non-Loro bytes as a document and fail on unrelated grounds. So
  // every ref the suite exercises falls through #treeEntry to the inner
  // store — exactly the path the production dual-plane wiring depends on for
  // any document the tree does not (yet) hold.
  describeDocumentStoreConformance(async () => {
    const { inner, routed, index } = await stores()
    await index.createWorkspace({ workspaceId: 'conformance-ws' })
    await index.createDocument({ workspaceId: 'conformance-ws', path: 'seed', kind: 'spatial' })
    return {
      store: routed,
      writeUnreadableRecord: (docRef) => inner.writeUnreadableRecord(docRef),
      // The file-level beforeEach/afterEach own tempDir + the db handle
      // (fresh per case), so there is nothing extra to tear down here.
      dispose: async () => {},
    }
  })
})
