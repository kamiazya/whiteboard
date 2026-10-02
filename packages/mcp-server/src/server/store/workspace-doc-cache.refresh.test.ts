/**
 * The workspace-record cache against a SECOND PROCESS over the same data
 * directory.
 *
 * `npx @kamiazya/whiteboard-mcp` (the agent) and `whiteboard daemon run` (the
 * browser's keeper) each hold their own in-memory copy of the record, and a
 * cache that trusts itself serves one process the other's writes only after it
 * restarts. The other process here is a write straight to the store, which is
 * all a second process is to this one: bytes under it that the cache never
 * saw.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceDocumentAtPath,
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId, nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
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

const { saveDocument, getDoc, listDocuments, getWorkspaceDoc, onWorkspaceDocUpdated } =
  await import('./document-store.js')
const { cacheBackedWorkspaceDocs, catchUpWorkspaceDoc, _clearWorkspaceDocCacheForTests } =
  await import('./workspace-doc-cache.js')
const { clearDocCacheForTests } = await import('./doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
const WS = 'ws-follow'

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-doc-refresh-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  })
  return doc
}

function textOf(doc: LoroDoc): string | null {
  const node = readSpatialCanvas(doc).nodes[0]
  return node === undefined ? null : (nodeText(node) ?? null)
}

/** What another process does: open the stored record, change it, save it. */
async function otherProcessWrites(change: (record: LoroDoc) => void): Promise<void> {
  const docs = new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(await getDb(tempDir)))
  const record = (await docs.open(WS)) ?? new LoroDoc()
  change(record)
  record.commit()
  await docs.save(WS, record)
}

function otherProcessCreates(path: string, text: string): Promise<void> {
  return otherProcessWrites((record) => {
    const documentId = generateDocumentId()
    createWorkspaceDocumentAtPath(record, { path, documentId, kind: 'spatial' })
    writeWorkspaceDocumentContent(record, documentId, canvasDoc(text))
  })
}

function otherProcessEdits(path: string, text: string): Promise<void> {
  return otherProcessWrites((record) => {
    const entry = resolveWorkspaceDocument(record, path)
    if (entry === null) throw new Error(`no document at ${path}`)
    writeWorkspaceDocumentContent(record, entry.documentId, canvasDoc(text))
  })
}

describe('a cached workspace record next to a second process', () => {
  it('lists a document the other process created after this one cached the record', async () => {
    await saveDocument(WS, 'mine', canvasDoc('mine'), { kind: 'spatial' })
    expect((await listDocuments(WS)).map((entry) => entry.path)).toEqual(['mine'])

    await otherProcessCreates('theirs', 'theirs')

    expect((await listDocuments(WS)).map((entry) => entry.path).sort()).toEqual(['mine', 'theirs'])
  })

  it("serves the other process's edit through a per-document projection it already cached", async () => {
    await saveDocument(WS, 'shared', canvasDoc('before'), { kind: 'spatial' })
    expect(textOf(await getDoc(WS, 'shared'))).toBe('before')

    await otherProcessEdits('shared', 'after')

    expect(textOf(await getDoc(WS, 'shared'))).toBe('after')
  })

  it('keeps both writes when this process saves after the other one wrote', async () => {
    await saveDocument(WS, 'mine', canvasDoc('mine'), { kind: 'spatial' })
    await otherProcessCreates('theirs', 'theirs')

    await saveDocument(WS, 'later', canvasDoc('later'), { kind: 'spatial' })

    const stored = await new DocumentStoreWorkspaceDocs(
      new LibsqlDocumentStore(await getDb(tempDir)),
    ).open(WS)
    expect(stored).not.toBeNull()
    const paths = (await listDocuments(WS)).map((entry) => entry.path).sort()
    expect(paths).toEqual(['later', 'mine', 'theirs'])
  })

  it('hands back the same document instance when nothing moved', async () => {
    await saveDocument(WS, 'mine', canvasDoc('mine'), { kind: 'spatial' })
    const first = await getWorkspaceDoc(WS)

    expect(await getWorkspaceDoc(WS)).toBe(first)
    await listDocuments(WS)
    expect(await getWorkspaceDoc(WS)).toBe(first)
  })

  it('announces what it caught up on, and only that, so a subscriber stays level', async () => {
    await saveDocument(WS, 'mine', canvasDoc('mine'), { kind: 'spatial' })
    const held = await getWorkspaceDoc(WS)
    const replica = new LoroDoc()
    replica.import(held.export({ mode: 'snapshot' }))
    const heard: Uint8Array[] = []
    const stop = onWorkspaceDocUpdated((_workspaceId, update) => heard.push(update))
    try {
      await listDocuments(WS)
      expect(heard).toEqual([])

      await otherProcessCreates('theirs', 'theirs')
      await listDocuments(WS)
      expect(heard).toHaveLength(1)
      for (const update of heard) replica.import(update)
      expect(resolveWorkspaceDocument(replica, 'theirs')).not.toBeNull()

      await listDocuments(WS)
      expect(heard).toHaveLength(1)
    } finally {
      stop()
    }
  })

  it('does not re-announce its own save when it next reads', async () => {
    await saveDocument(WS, 'mine', canvasDoc('mine'), { kind: 'spatial' })
    const heard: Uint8Array[] = []
    const stop = onWorkspaceDocUpdated((_workspaceId, update) => heard.push(update))
    try {
      await saveDocument(WS, 'mine', canvasDoc('mine again'), { kind: 'spatial', overwrite: true })
      const afterSave = heard.length
      await listDocuments(WS)
      await getDoc(WS, 'mine')
      expect(heard).toHaveLength(afterSave)
    } finally {
      stop()
    }
  })

  it('takes in what the other process wrote without losing an edit it has not saved yet', async () => {
    await saveDocument(WS, 'mine', canvasDoc('mine'), { kind: 'spatial' })
    const held = await getWorkspaceDoc(WS)
    // Concurrent with the other process's write, not ahead of or behind it.
    held.getMap('unsaved').set('key', 'value')
    held.commit()

    await otherProcessCreates('theirs', 'theirs')

    expect((await listDocuments(WS)).map((entry) => entry.path).sort()).toEqual(['mine', 'theirs'])
    expect(held.getMap('unsaved').get('key')).toBe('value')
  })

  it('tells the subscribers what a pass for the file sweeper caught up on, and nothing when level', async () => {
    await saveDocument(WS, 'mine', canvasDoc('mine'), { kind: 'spatial' })
    const heard: Uint8Array[] = []
    const stop = onWorkspaceDocUpdated((_workspaceId, update) => heard.push(update))
    try {
      await catchUpWorkspaceDoc(WS)
      expect(heard).toEqual([])

      await otherProcessCreates('theirs', 'theirs')
      await catchUpWorkspaceDoc(WS)
      expect(heard).toHaveLength(1)
      // Level now, so the next access has nothing left to announce.
      await listDocuments(WS)
      expect(heard).toHaveLength(1)
    } finally {
      stop()
    }
  })

  it('answers a tail pass over a level document without reading the log', async () => {
    await saveDocument(WS, 'mine', canvasDoc('mine'), { kind: 'spatial' })
    const docs = cacheBackedWorkspaceDocs()
    const held = await getWorkspaceDoc(WS)
    const cursor = await docs.readCursor(WS)
    const readLog = vi.spyOn(LibsqlDocumentStore.prototype, 'loadDeltas')
    try {
      const caughtUp = await docs.catchUp(WS, held, cursor)

      expect(readLog).not.toHaveBeenCalled()
      expect(caughtUp.updates).toEqual([])
      expect(caughtUp.cursor).toEqual(cursor)
    } finally {
      readLog.mockRestore()
    }
  })

  it('still reads the log for a tail pass when the other process wrote', async () => {
    await saveDocument(WS, 'mine', canvasDoc('mine'), { kind: 'spatial' })
    const docs = cacheBackedWorkspaceDocs()
    const held = await getWorkspaceDoc(WS)
    const cursor = await docs.readCursor(WS)
    await otherProcessCreates('theirs', 'theirs')

    const caughtUp = await docs.catchUp(WS, held, cursor)

    expect(caughtUp.updates.length).toBeGreaterThan(0)
    expect(resolveWorkspaceDocument(held, 'theirs')).not.toBeNull()
  })
})
