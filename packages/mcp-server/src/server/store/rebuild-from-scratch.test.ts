/**
 * The dual-plane collapse's permanent acceptance test (S8): the workspace
 * tree is the address book, so the ENTIRE document surface — listing,
 * content, names, pins, branches, versions, rename, delete — must work
 * across a restart with no `documents` table at all.
 *
 * Migration 0017 dropped the table outright; nothing here may need it. If a
 * future change quietly reintroduces a row read or write, this file is what
 * goes red.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
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

const {
  saveDocument,
  loadDocument,
  listDocuments,
  renameDocumentPath,
  deleteDocument,
  workspaceExists,
  _clearWorkspaceDocCacheForTests,
} = await import('./document-store.js')
const { clearCache } = await import('./doc-cache.js')
const { loadWorkspaceNames, setDocumentDisplayName, setDocumentPinned } = await import(
  './names-store.js'
)
const { createBranch, loadDocumentBranches } = await import('./branches-store.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'rebuild-scratch-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
  _clearWorkspaceDocCacheForTests()
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

/** Migration 0017 dropped the documents table outright: the tree is the whole address book. */
async function documentsTableExists(): Promise<boolean> {
  const db = await getDb(tempDir)
  const row = await db
    .selectFrom('sqlite_master' as never)
    .select(['name' as never])
    .where('type', '=', 'table')
    .where('name', '=', 'documents')
    .executeTakeFirst()
  return row !== undefined
}

it('the whole document surface works with no documents table at all, across a restart', async () => {
  const WS = 'ws-scratch'

  // ── Build a world through the real surfaces ──
  await saveDocument(WS, 'boards/main', canvasDoc('the canvas'), { kind: 'spatial' })
  await saveDocument(WS, 'notes/readme', new LoroDoc(), { kind: 'markdown' })
  await setDocumentDisplayName(WS, 'boards/main', 'Main Board')
  await setDocumentPinned(WS, 'notes/readme', true)
  await createBranch(WS, 'boards/main', { name: 'feature' })
  const versionStore = new FileVersionStore()
  const version = await versionStore.save(WS, 'boards/main', canvasDoc('the canvas'), {
    auto: false,
    label: 'checkpoint',
  })

  // The address book is the tree: no documents table exists at all.
  expect(await documentsTableExists()).toBe(false)

  // ── Restart: drop every in-memory cache, exactly as a fresh daemon
  //    process would over this data dir ──
  clearCache()
  _clearWorkspaceDocCacheForTests()

  // ── Everything answers from the stored workspace records alone ──
  expect(await workspaceExists(WS)).toBe(true)

  const listing = await listDocuments(WS)
  expect(listing.map((d) => [d.path, d.kind])).toEqual([
    ['boards/main', 'spatial'],
    ['notes/readme', 'markdown'],
  ])
  expect(listing.find((d) => d.path === 'boards/main')?.displayName).toBe('Main Board')

  const loaded = await loadDocument(WS, 'boards/main')
  const canvas = readSpatialCanvas(loaded)
  expect(canvas.nodes[0]?.type === 'text' ? canvas.nodes[0].text : null).toBe('the canvas')

  const names = await loadWorkspaceNames(WS)
  expect(names.documents['boards/main']).toBe('Main Board')
  expect(names.pinned).toEqual(['notes/readme'])

  const branches = await loadDocumentBranches(WS, 'boards/main')
  expect(branches.branches.map((b) => b.name).sort()).toEqual(['feature', 'main'])

  const versions = await versionStore.list(WS, 'boards/main')
  expect(versions.map((v) => v.id)).toContain(version.id)

  // Mutations keep working — with no documents table to keep in sync.
  await renameDocumentPath(WS, 'notes/readme', 'notes/README')
  expect((await listDocuments(WS)).map((d) => d.path)).toEqual(['boards/main', 'notes/README'])
  expect(await deleteDocument(WS, 'notes/README')).toBe(true)
  expect((await listDocuments(WS)).map((d) => d.path)).toEqual(['boards/main'])
  expect(await documentsTableExists()).toBe(false)
})
