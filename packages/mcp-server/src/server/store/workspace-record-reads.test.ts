/**
 * What the store's reads of a workspace record answer, as one workspace holds
 * them: a listing, the kind and id at a path, the names and pins, the stamp of
 * the last compaction, and whether a document sits in the trash. Each read goes
 * to the record however the cache holds it, and none of them changes it.
 */

import './_test-loro-records.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setWorkspaceLastCompactedAt } from '@kamiazya/whiteboard-loro-adapter'
import { workspaceIdFor } from '@kamiazya/whiteboard-model/test-utils'
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

const {
  saveDocument,
  listDocuments,
  getDocumentKind,
  documentExists,
  resolveDocumentIdAtPath,
  renameDocumentPath,
  deleteDocument,
  readLatestCompactedAt,
  getWorkspaceDoc,
  _clearWorkspaceDocCacheForTests,
} = await import('./document-store.js')
const { saveWorkspaceDoc } = await import('./workspace-doc-cache.js')
const { loadWorkspaceNames, setDocumentDisplayName, setDocumentPinned } = await import(
  './names-store.js'
)
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')

const WS = workspaceIdFor('record-reads')
const OTHER = workspaceIdFor('record-reads-other')
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'record-reads-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  _clearWorkspaceDocCacheForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

async function seed(): Promise<void> {
  await saveDocument(WS, 'notes/a', new LoroDoc(), { kind: 'markdown' })
  await saveDocument(WS, 'notes/b', new LoroDoc(), { kind: 'markdown' })
  await saveDocument(WS, 'board', new LoroDoc(), { kind: 'spatial' })
}

describe('the listing and the lookups by path', () => {
  it('lists every document with its path, kind and digest, and answers kind and id by path', async () => {
    await seed()

    const listed = await listDocuments(WS)
    expect(listed.map((entry) => entry.path).sort()).toEqual(['board', 'notes/a', 'notes/b'])
    expect(Object.fromEntries(listed.map((entry) => [entry.path, entry.kind]))).toEqual({
      board: 'spatial',
      'notes/a': 'markdown',
      'notes/b': 'markdown',
    })
    for (const entry of listed) {
      expect(entry.contentDigest).toMatch(/\S/)
      expect(await resolveDocumentIdAtPath(WS, entry.path)).toBe(entry.documentId)
      expect(await documentExists(WS, entry.path)).toBe(true)
    }
    expect(await getDocumentKind(WS, 'board')).toBe('spatial')
    expect(await getDocumentKind(WS, 'notes/a')).toBe('markdown')
  })

  it('answers the empty and the absent without minting a record', async () => {
    expect(await listDocuments(OTHER)).toEqual([])
    expect(await getDocumentKind(OTHER, 'nothing')).toBeNull()
    expect(await resolveDocumentIdAtPath(OTHER, 'nothing')).toBeNull()
    expect(await documentExists(OTHER, 'nothing')).toBe(false)
    await seed()
    expect(await getDocumentKind(WS, 'nothing')).toBeNull()
    expect(await documentExists(WS, 'nothing')).toBe(false)
  })

  it('follows a move: the old path is gone and the new one holds the document', async () => {
    await seed()
    const before = await resolveDocumentIdAtPath(WS, 'notes/a')
    await renameDocumentPath(WS, 'notes/a', 'notes/moved')
    expect(await resolveDocumentIdAtPath(WS, 'notes/a')).toBeNull()
    expect(await resolveDocumentIdAtPath(WS, 'notes/moved')).toBe(before)
  })
})

describe('the names and the pins', () => {
  it('reads each document name by path, and the pinned paths', async () => {
    await seed()
    await setDocumentDisplayName(WS, 'notes/a', 'Alpha')
    await setDocumentPinned(WS, 'board', true)

    expect(await loadWorkspaceNames(WS)).toEqual({
      documents: { 'notes/a': 'Alpha' },
      pinned: ['board'],
    })
    expect(await loadWorkspaceNames(OTHER)).toEqual({ documents: {}, pinned: [] })
  })
})

describe('the stamp of the last compaction', () => {
  it('is the newest across workspaces, and null when none was compacted', async () => {
    await seed()
    await saveDocument(OTHER, 'x', new LoroDoc(), { kind: 'markdown' })
    expect(await readLatestCompactedAt()).toBeNull()

    for (const [workspaceId, at] of [
      [WS, 1000],
      [OTHER, 3000],
    ] as const) {
      const record = await getWorkspaceDoc(workspaceId)
      setWorkspaceLastCompactedAt(record, at)
      await saveWorkspaceDoc(workspaceId, record)
    }
    expect(await readLatestCompactedAt()).toBe(3000)
  })
})

describe('what a delete leaves of a document the trash holds', () => {
  it('keeps the version rows of a document that went to the trash', async () => {
    await seed()
    const store = new FileVersionStore()
    const version = await store.save(WS, 'notes/b', { auto: true })

    expect(await deleteDocument(WS, 'notes/b')).toBe(true)

    const rows = await (await getDb(tempDir))
      .selectFrom('versions')
      .select('id')
      .where('id', '=', version.id)
      .execute()
    expect(rows).toEqual([{ id: version.id }])
    expect(await documentExists(WS, 'notes/b')).toBe(false)
  })
})
