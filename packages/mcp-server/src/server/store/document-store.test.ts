import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  isWorkspaceNotFoundError,
  isWorkspaceSegmentTakenError,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Swap DATA_DIR to a temp directory through vi.mock.
let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Use dynamic import so it runs after the mock is resolved.
const {
  saveDocument,
  loadDocument,
  listDocuments,
  listWorkspaces,
  compactDocument,
  renameDocumentPath,
  ConflictError,
  getDocumentKind,
  setDocumentSavedListener,
} = await import('./document-store.js')
const {
  scheduleAutoCompact,
  uninstallAutoCompact,
  disposeAutoCompact,
  _inFlightAutoCompactCountForTests,
  _isDisposingAutoCompactForTests,
} = await import('./auto-compact.js')
const { captureLogsForTests } = await import('../log.js')
const { getDefaultServerDeps } = await import('../../di/default-server-deps.js')
const { wbDocumentDelete } = await import('@kamiazya/whiteboard-server-core')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

async function setupIsolatedDb(): Promise<void> {
  handle = await createIsolatedDb({ dataDir: tempDir })
}

async function teardownIsolatedDb(): Promise<void> {
  await handle.dispose()
}

describe('loadDocument reads through LibsqlDocumentStore (identity-convergence flip)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-flip-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('a saveDocument write is immediately durable in the stored workspace record', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { resolveDocumentIdAtPath } = await import('./document-store.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { DocumentStoreWorkspaceDocs } = await import('@kamiazya/whiteboard-workspace-index')
    const { documentContainers } = await import('@kamiazya/whiteboard-loro-adapter')

    const doc = new LoroDoc()
    doc.getText('content').insert(0, 'written via saveDocument')
    doc.commit()
    await saveDocument('session1', 'write-through', doc)

    const db = await getDb(getDataDir())
    const documentId = await resolveDocumentIdAtPath('session1', 'write-through')
    expect(documentId).not.toBeNull()
    // A FRESH open of the stored record — not the live cache — so this
    // proves durability, not memory.
    const stored = await new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).open(
      'session1',
    )
    expect(stored).not.toBeNull()
    expect(documentContainers(stored!, documentId!).getText('content').toString()).toBe(
      'written via saveDocument',
    )
  })
})

// Every writer of a workspace's content — the HTTP/WS route path
// (saveDocument) and the MCP tool surface (WorkspaceRoutedDocumentStore) —
// mutates the SAME live workspace document, so they must serialize on the
// workspace write lock and the route flow must LOAD inside that lock: a
// projection read before a tool write completed would diff the tool's edit
// right back out.
describe('route saves and tool writes serialize on the workspace document', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-lock-race-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  async function toolStores() {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { WorkspaceRoutedDocumentStore } = await import('./workspace-plane.js')
    const db = await getDb(getDataDir())
    return { db, routed: new WorkspaceRoutedDocumentStore(new LibsqlDocumentStore(db)) }
  }

  async function toolWrite(
    routed: import('./workspace-plane.js').WorkspaceRoutedDocumentStore,
    documentId: string,
    marker: string,
  ): Promise<void> {
    const { chunkSnapshot, reassembleSnapshot } = await import('@kamiazya/whiteboard-ports')
    const { withDocumentWriteLock } = await import('./workspace-lock.js')
    const docRef = { kind: 'document' as const, workspaceId: 'session1', documentId }
    await withDocumentWriteLock(documentId, async () => {
      const existing = await routed.loadSnapshot({ docRef })
      const doc = new LoroDoc()
      if (existing !== null) doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
      doc.getMap('nodes').set(marker, { id: marker })
      doc.commit()
      const { manifest, chunks } = chunkSnapshot(
        new Uint8Array(doc.export({ mode: 'snapshot' })),
        1_000_000,
      )
      await routed.saveSnapshot({
        docRef,
        manifest,
        chunks,
        frontier: new Uint8Array(doc.oplogVersion().encode()),
      })
    })
  }

  // The route flow exactly as ws.ts and live-doc.ts run it: resolve the doc
  // AND persist it inside one workspace-lock hold.
  async function routeWrite(path: string, marker: string): Promise<void> {
    const { getDoc } = await import('./document-store.js')
    const { withWorkspaceWriteLock } = await import('./workspace-lock.js')
    await withWorkspaceWriteLock('session1', async () => {
      const doc = await getDoc('session1', path)
      doc.getMap('nodes').set(marker, { id: marker })
      doc.commit()
      await saveDocument('session1', path, doc, { overwrite: true })
    })
  }

  it('a tool write and a route save racing on the same document both survive', async () => {
    const { resolveDocumentIdAtPath } = await import('./document-store.js')
    const seed = new LoroDoc()
    seed.getMap('nodes').set('base', { id: 'base' })
    seed.commit()
    await saveDocument('session1', 'race', seed)
    const { routed } = await toolStores()
    const documentId = (await resolveDocumentIdAtPath('session1', 'race'))!

    await Promise.all([toolWrite(routed, documentId, 'agent'), routeWrite('race', 'web')])

    const reloaded = await loadDocument('session1', 'race')
    expect(reloaded.getMap('nodes').keys().sort()).toEqual(['agent', 'base', 'web'])
  })

  // Sequential shape of the same guarantee, pinning the MECHANISM: the tool
  // surface reads and writes THROUGH the cached projection the route path
  // mutates, so a tool save is a CRDT merge into the same lineage — the
  // live cached doc gains the tool's op instead of being left stale (or
  // evicted, which would break every per-document socket's lineage).
  it("a route save after an out-of-band tool write preserves both writers' ops", async () => {
    const { resolveDocumentIdAtPath, getDoc } = await import('./document-store.js')
    const { peekDoc } = await import('./doc-cache.js')

    const seed = new LoroDoc()
    seed.getMap('nodes').set('base', { id: 'base' })
    seed.commit()
    await saveDocument('session1', 'merge-race', seed, { overwrite: true })
    // Warm the projection cache the way a WS session would.
    await getDoc('session1', 'merge-race')
    expect(peekDoc('session1', 'merge-race')).toBeDefined()

    const { routed } = await toolStores()
    const documentId = (await resolveDocumentIdAtPath('session1', 'merge-race'))!
    await toolWrite(routed, documentId, 'agent')

    // The cached projection STAYS, and already carries the tool's op —
    // a WS session holding it keeps its lineage and sees the edit.
    const cached = peekDoc('session1', 'merge-race')
    expect(cached).toBeDefined()
    expect(cached!.getMap('nodes').keys().sort()).toEqual(['agent', 'base'])
    // The route flow writes through the same instance and both ops survive.
    await routeWrite('merge-race', 'web')
    const reloaded = await loadDocument('session1', 'merge-race')
    expect(reloaded.getMap('nodes').keys().sort()).toEqual(['agent', 'base', 'web'])
  })
})

describe('saveDocument / loadDocument', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
    // Create the session directory.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saves and restores an empty LoroDoc', async () => {
    const doc = new LoroDoc()
    await saveDocument('session1', 'test', doc)

    const loaded = await loadDocument('session1', 'test')
    // An empty doc should have an empty elements list.
    expect(loaded.getMovableList('elements').length).toBe(0)
  })

  it("persists the workspace record's frontier as the live workspace doc's oplog version", async () => {
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { getWorkspaceDoc } = await import('./document-store.js')
    const doc = new LoroDoc()
    doc.getMovableList('elements').insert(0, 'x')
    doc.commit()
    await saveDocument('session1', 'frontier-check', doc)

    const db = await getDb(tempDir)
    const store = new LibsqlDocumentStore(db)
    const result = await store.readFrontier({
      docRef: { kind: 'workspace-tree', workspaceId: 'session1' },
    })
    const workspaceDoc = await getWorkspaceDoc('session1')
    expect(result?.frontier).toEqual(workspaceDoc.oplogVersion().encode())
  })

  it('appends a delta on re-save instead of rewriting the whole snapshot', async () => {
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

    // Big enough that rewriting it would be the obvious cost. The daemon
    // exported the whole thing on EVERY save, so an 88-byte edit to a
    // megabyte document wrote a megabyte.
    const doc = new LoroDoc()
    const nodes = doc.getMap('nodes')
    for (let i = 0; i < 4000; i += 1) nodes.set(`n${i}`, { type: 'text', x: i, text: `node ${i}` })
    doc.commit()
    await saveDocument('session1', 'incremental', doc)

    const db = await getDb(tempDir)
    const docRef = { kind: 'workspace-tree' as const, workspaceId: 'session1' }
    const store = new LibsqlDocumentStore(db)
    const baseline = await store.readSnapshotManifest({ docRef })
    expect(baseline).not.toBeNull()

    nodes.set('n0', { type: 'text', x: 999, text: 'edited' })
    doc.commit()
    await saveDocument('session1', 'incremental', doc, { overwrite: true })

    // The workspace record's snapshot is untouched — byte-for-byte the one
    // the first save wrote.
    expect(await store.readSnapshotManifest({ docRef })).toEqual(baseline)
    // And the edit is in the delta log, small.
    const { updates } = await store.loadDeltas({ docRef, afterSeq: null })
    expect(updates).toHaveLength(1)
    expect(updates[0]!.byteLength).toBeLessThan(baseline!.manifest.totalBytes / 10)
  })

  it('does not grow the delta log when the document has not changed', async () => {
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

    const doc = new LoroDoc()
    doc.getMap('nodes').set('a', { text: 'only edit' })
    doc.commit()
    await saveDocument('session1', 'idle', doc)

    // Saves with nothing between them. An autosave loop and a WS heartbeat
    // both produce exactly this, so a log that grows here grows without a
    // bound on an untouched document.
    for (let i = 0; i < 5; i += 1) {
      await saveDocument('session1', 'idle', doc, { overwrite: true })
    }

    const db = await getDb(tempDir)
    const store = new LibsqlDocumentStore(db)
    const docRef = { kind: 'workspace-tree' as const, workspaceId: 'session1' }
    const { updates } = await store.loadDeltas({ docRef, afterSeq: null })
    // Exactly what the CONTENT-BEARING save appended (the record is minted
    // empty at workspace creation, so the first content arrives as one
    // delta) — and not one entry more. An update carrying no ops is still
    // 22 bytes of envelope, which is exactly why "did it grow?" cannot be
    // asked of the bytes.
    expect(updates).toHaveLength(1)
  })

  it('reads back everything a re-save appended, not just the snapshot', async () => {
    const doc = new LoroDoc()
    doc.getMap('nodes').set('a', { text: 'first' })
    doc.commit()
    await saveDocument('session1', 'roundtrip', doc)

    doc.getMap('nodes').set('b', { text: 'second' })
    doc.commit()
    await saveDocument('session1', 'roundtrip', doc, { overwrite: true })

    // The whole point of appending rather than rewriting is that a reader
    // still sees one document. A load that returned only the snapshot would
    // silently drop every edit since it.
    const loaded = await loadDocument('session1', 'roundtrip')
    expect(loaded?.getMap('nodes').toJSON()).toEqual({
      a: { text: 'first' },
      b: { text: 'second' },
    })
  })

  it('mints a canonical ULID for a new row, so both writers share one id space', async () => {
    // The document index and saveDocument both create rows in the same table.
    // The index mints ULIDs (the port's DocumentEntry accepts nothing else),
    // while saveDocument minted nanoids — so every canvas created through the
    // web UI became a row the agent surface must skip. Two writers, one
    // table, one id policy.
    await saveDocument('session1', 'ulid-mint', new LoroDoc())
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const _db = await getDb(getDataDir())
    const rowId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      'session1',
      'ulid-mint',
    )
    const row = rowId === null ? undefined : { id: rowId }
    expect(row?.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  })

  it('saves and restores a LoroDoc with elements', async () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(0, new (await import('loro-crdt')).LoroMap())
    map.set('id', 'elem-001')
    map.set('type', 'rectangle')
    map.set('x', 100)
    map.set('y', 200)
    doc.commit()

    await saveDocument('session1', 'canvas-with-elem', doc)
    const loaded = await loadDocument('session1', 'canvas-with-elem')

    const elements = loaded.getMovableList('elements').toJSON() as {
      id: string
      type: string
      x: number
    }[]
    expect(elements).toHaveLength(1)
    expect(elements[0].id).toBe('elem-001')
    expect(elements[0].type).toBe('rectangle')
    expect(elements[0].x).toBe(100)
  })

  // Daemon mode persists a canvas through THIS path, not through
  // documentStore — a separate implementation, so the sidecar-map contract
  // node/edge lock relies on has to be pinned here too. It holds because
  // saveDocument writes doc.export({ mode: 'snapshot' }) verbatim rather than
  // re-serializing through readSpatialCanvas, which would drop everything
  // outside the canvas value.
  it('round-trips node and edge locks, which live outside the canvas value', async () => {
    const { setEdgeLock, setNodeLock, readEdgeLocks, readNodeLocks, writeSpatialCanvas } =
      await import('@kamiazya/whiteboard-loro-adapter')
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
        { id: 'n2', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'b' },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    })
    setNodeLock(doc, 'n1', true)
    setEdgeLock(doc, 'e1', true)

    await saveDocument('session1', 'locked', doc)
    const loaded = await loadDocument('session1', 'locked')

    expect(readNodeLocks(loaded)).toEqual(new Set(['n1']))
    expect(readEdgeLocks(loaded)).toEqual(new Set(['e1']))
  })

  it('returns an empty LoroDoc for a missing canvas', async () => {
    const doc = await loadDocument('session1', 'nonexistent')
    expect(doc.getMovableList('elements').length).toBe(0)
  })

  it('throws on a broken workspace record instead of returning an empty LoroDoc', async () => {
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')
    const { _clearWorkspaceDocCacheForTests } = await import('./document-store.js')
    await saveDocument('session1', 'broken', new LoroDoc())
    const db = await getDb(tempDir)
    // Overwrite the workspace record's snapshot rows directly with bytes
    // that are not a valid Loro snapshot — the corruption a Libsql-backed
    // store can suffer.
    const store = new LibsqlDocumentStore(db)
    const { manifest, chunks } = chunkSnapshot(Buffer.from('not-a-loro-snapshot'), 1_000_000)
    await store.saveSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: 'session1' },
      manifest,
      chunks,
      frontier: new Uint8Array(),
    })
    // The live cache still holds the pre-corruption doc; drop it so the read
    // actually exercises the stored bytes.
    _clearWorkspaceDocCacheForTests()

    await expect(loadDocument('session1', 'broken')).rejects.toThrow()
  })

  it('saves and loads separate paths independently', async () => {
    const doc1 = new LoroDoc()
    doc1.getMovableList('elements')
    doc1.commit()

    const doc2 = new LoroDoc()
    const list2 = doc2.getMovableList('elements')
    const { LoroMap: LM } = await import('loro-crdt')
    const m = list2.insertContainer(0, new LM())
    m.set('id', 'elem-in-canvas2')
    doc2.commit()

    await saveDocument('session1', 'canvas-a', doc1)
    await saveDocument('session1', 'canvas-b', doc2)

    const loadedA = await loadDocument('session1', 'canvas-a')
    const loadedB = await loadDocument('session1', 'canvas-b')

    expect(loadedA.getMovableList('elements').length).toBe(0)
    expect(loadedB.getMovableList('elements').length).toBe(1)
    const bElems = loadedB.getMovableList('elements').toJSON() as { id: string }[]
    expect(bElems[0].id).toBe('elem-in-canvas2')
  })
})

describe('saveDocument - overwrite handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('throws ConflictError when overwrite: false targets an existing file', async () => {
    await saveDocument('session1', 'existing', new LoroDoc())
    await expect(
      saveDocument('session1', 'existing', new LoroDoc(), { overwrite: false }),
    ).rejects.toThrow(/already exists/)
  })

  it('defaults to the same behavior as overwrite: false', async () => {
    await saveDocument('session1', 'existing', new LoroDoc())
    await expect(saveDocument('session1', 'existing', new LoroDoc())).rejects.toThrow(
      /already exists/,
    )
  })

  it('overwrites an existing file when overwrite: true', async () => {
    const docA = new LoroDoc()
    docA.getMovableList('elements')
    docA.commit()
    await saveDocument('session1', 'existing', docA)

    const docB = new LoroDoc()
    const list = docB.getMovableList('elements')
    const { LoroMap: LM } = await import('loro-crdt')
    const m = list.insertContainer(0, new LM())
    m.set('id', 'overwritten')
    docB.commit()

    await expect(
      saveDocument('session1', 'existing', docB, { overwrite: true }),
    ).resolves.toBeUndefined()

    const loaded = await loadDocument('session1', 'existing')
    const elements = loaded.getMovableList('elements').toJSON() as { id: string }[]
    expect(elements).toHaveLength(1)
    expect(elements[0].id).toBe('overwritten')
  })

  it('succeeds with overwrite: false when the file does not exist yet', async () => {
    await expect(
      saveDocument('session1', 'fresh', new LoroDoc(), { overwrite: false }),
    ).resolves.toBeUndefined()
  })

  it('sets name="ConflictError" for caller-side discrimination', async () => {
    await saveDocument('session1', 'existing', new LoroDoc())
    await expect(
      saveDocument('session1', 'existing', new LoroDoc(), { overwrite: false }),
    ).rejects.toMatchObject({ name: 'ConflictError' })
  })

  it('does not leave an orphan documents row behind when the snapshot+commit step fails', async () => {
    // Older cuts of saveDocument committed the documents row before writing the
    // .loro file, so any failure between that DB write and the blob commit
    // stranded the row and made every future saveDocument hit ConflictError
    // forever. The exact failure point is incidental — what matters is that
    // a partial save leaves no DB row behind. Spying on LoroDoc#export gives
    // us a deterministic way to fail in the snapshot stage that works the
    // same on root and non-root environments (chmod-based blocks would no-op
    // for root in containers / sudo).
    const exportSpy = vi.spyOn(LoroDoc.prototype, 'export').mockImplementationOnce(() => {
      throw new Error('snapshot serialization failed')
    })

    await expect(saveDocument('session1', 'orphan-prone', new LoroDoc())).rejects.toThrow(
      /snapshot serialization failed/,
    )

    exportSpy.mockRestore()

    await expect(saveDocument('session1', 'orphan-prone', new LoroDoc())).resolves.toBeUndefined()
  })
})

describe('listDocuments', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns only .loro files as paths without extensions', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    await saveDocument('session1', 'canvas-b', new LoroDoc())

    // Create a .port file and confirm it is excluded.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tempDir, 'session1', '.port'), '3099')

    const list = await listDocuments('session1')
    const paths = list.map((c) => c.path)

    expect(paths).toContain('canvas-a')
    expect(paths).toContain('canvas-b')
    expect(paths).not.toContain('.port')
    expect(paths).not.toContain('exports')
  })

  it('reports a recorded kind unchanged', async () => {
    await saveDocument('session1', 'a-note', new LoroDoc(), { kind: 'markdown' })
    const [entry] = await listDocuments('session1')
    expect(entry?.kind).toBe('markdown')
  })

  // A path is an auto-generated address ('untitled-2'); the display name is
  // the only identifier the user ever chose. A client that lists documents
  // to resolve a `[[Name]]` link, or to offer link targets, has to be able
  // to read the name from the SAME list it renders — fetching it separately
  // is what let the two disagree.
  it('carries the display name when one is recorded', async () => {
    await saveDocument('session1', 'untitled-2', new LoroDoc())
    const { setDocumentDisplayName } = await import('./names-store.js')
    await setDocumentDisplayName('session1', 'untitled-2', '週次レビュー')

    const [entry] = await listDocuments('session1')

    expect(entry?.path).toBe('untitled-2')
    expect(entry?.displayName).toBe('週次レビュー')
  })

  it('omits the display name for a document that was never renamed', async () => {
    await saveDocument('session1', 'untitled', new LoroDoc())
    const [entry] = await listDocuments('session1')
    expect(entry?.displayName).toBeUndefined()
  })

  it('returns an empty array for an empty session', async () => {
    const list = await listDocuments('session1')
    expect(list).toHaveLength(0)
  })

  it('returns an empty array only when the session directory is missing', async () => {
    const list = await listDocuments('missing-session')
    expect(list).toEqual([])
  })

  it('includes updatedAt on each entry', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const list = await listDocuments('session1')
    expect(list[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('includes the immutable canvas id on each entry, stable across a path rename', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const before = await listDocuments('session1')
    expect(before[0].id).toBeTruthy()

    await renameDocumentPath('session1', 'canvas-a', 'canvas-renamed')
    const after = await listDocuments('session1')
    expect(after[0].path).toBe('canvas-renamed')
    // The id is what stored references key on; a rename must not move it.
    expect(after[0].id).toBe(before[0].id)
  })

  it('persists kind: markdown and lists it back', async () => {
    await saveDocument('session1', 'note', new LoroDoc(), { kind: 'markdown' })
    const list = await listDocuments('session1')
    expect(list.find((c) => c.path === 'note')?.kind).toBe('markdown')
  })

  it("records 'spatial' for a kindless save — every document lands on the tree with a kind", async () => {
    // A kindless save is a lazy-create of an empty document (the WS/update
    // path on a path with no row); the spatial editor is what opens those,
    // and pre-kind rows no longer exist (the startup fold deletes them), so
    // this is a default about OUR OWN lazy-create, not a guess about
    // someone else's data.
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const list = await listDocuments('session1')
    expect(list.find((c) => c.path === 'canvas-a')?.kind).toBe('spatial')
  })

  it('does not reset kind on an overwrite:true re-save', async () => {
    await saveDocument('session1', 'note', new LoroDoc(), { kind: 'markdown' })
    await saveDocument('session1', 'note', new LoroDoc(), { overwrite: true })
    const list = await listDocuments('session1')
    expect(list.find((c) => c.path === 'note')?.kind).toBe('markdown')
  })

  it('syncs kind on an overwrite:true re-save when kind is explicitly passed', async () => {
    await saveDocument('session1', 'note', new LoroDoc(), { kind: 'spatial' })
    await saveDocument('session1', 'note', new LoroDoc(), { overwrite: true, kind: 'markdown' })
    const list = await listDocuments('session1')
    expect(list.find((c) => c.path === 'note')?.kind).toBe('markdown')
  })

  // Pinned counterexample from the S5a parity scoreboard (shrunk by
  // fast-check): create('a/y' as markdown) then an explicit-kind re-save
  // left the row saying 'spatial' while the tree node still said
  // 'markdown' — the kind sync above only wrote the row.
  it('an explicit-kind re-save updates the TREE node kind, not only the row', async () => {
    const { openWorkspaceDocIfStored } = await import('./document-store.js')
    const { resolveWorkspaceDocument } = await import('@kamiazya/whiteboard-loro-adapter')
    await saveDocument('session1', 'note', new LoroDoc(), { kind: 'markdown' })
    await saveDocument('session1', 'note', new LoroDoc(), { overwrite: true, kind: 'spatial' })

    const workspaceDoc = await openWorkspaceDocIfStored('session1')
    expect(workspaceDoc).not.toBeNull()
    if (workspaceDoc === null) throw new Error('unreachable')
    expect(resolveWorkspaceDocument(workspaceDoc, 'note')?.kind).toBe('spatial')
  })

  it('recursively lists nested paths as session-relative paths', async () => {
    await saveDocument('session1', 'top-level', new LoroDoc())
    await saveDocument('session1', '621/header', new LoroDoc())
    await saveDocument('session1', '621/footer', new LoroDoc())
    await saveDocument('session1', '622/a/b', new LoroDoc())

    const list = await listDocuments('session1')
    const paths = list.map((c) => c.path).sort()
    expect(paths).toEqual(['621/footer', '621/header', '622/a/b', 'top-level'])
  })

  it('excludes exports/, files/, and versions/ from listing', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await saveDocument('session1', 'real-canvas', new LoroDoc())
    // Files that only look like .loro files inside exports/, files/, or versions/
    // must still be excluded. versions/ also contains .loro files for the version store.
    await mkdir(join(tempDir, 'session1', 'exports'), { recursive: true })
    await writeFile(join(tempDir, 'session1', 'exports', 'fake.loro'), '')
    await mkdir(join(tempDir, 'session1', 'files'), { recursive: true })
    await writeFile(join(tempDir, 'session1', 'files', 'another.loro'), '')
    await mkdir(join(tempDir, 'session1', 'versions'), { recursive: true })
    await writeFile(join(tempDir, 'session1', 'versions', 'snap-001.loro'), '')
    await writeFile(join(tempDir, 'session1', 'versions', 'snap-002.loro'), '')

    const list = await listDocuments('session1')
    expect(list.map((c) => c.path)).toEqual(['real-canvas'])
  })

  // listDocuments no longer walks the filesystem; the previous corruption
  // tests against directory traversal failures and broken non-directory
  // paths no longer apply now that the listing is a SELECT against the
  // documents table.
})

describe('getDocumentKind', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns null when the canvas does not exist', async () => {
    expect(await getDocumentKind('session1', 'missing')).toBeNull()
  })

  it('returns the persisted kind for an existing canvas', async () => {
    await saveDocument('session1', 'note', new LoroDoc(), { kind: 'markdown' })
    expect(await getDocumentKind('session1', 'note')).toBe('markdown')
  })
})

describe('saveDocument / loadDocument - path validation', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('accepts valid kebab-case paths', async () => {
    // Verify that saveDocument does not throw.
    await expect(saveDocument('session1', 'my-canvas', new LoroDoc())).resolves.toBeUndefined()
    await expect(saveDocument('session1', '123-design', new LoroDoc())).resolves.toBeUndefined()
    await expect(saveDocument('session1', 'abc', new LoroDoc())).resolves.toBeUndefined()
  })

  it('accepts slash-separated nested paths when each segment is kebab-case', async () => {
    await expect(saveDocument('session1', '621/header', new LoroDoc())).resolves.toBeUndefined()
    await expect(
      saveDocument('session1', '621/header-v2/layout', new LoroDoc()),
    ).resolves.toBeUndefined()
  })

  it('rejects leading, trailing, and consecutive slashes', async () => {
    await expect(saveDocument('session1', '/foo', new LoroDoc())).rejects.toThrow('Invalid path')
    await expect(saveDocument('session1', 'foo/', new LoroDoc())).rejects.toThrow('Invalid path')
    await expect(saveDocument('session1', 'a//b', new LoroDoc())).rejects.toThrow('Invalid path')
  })

  it('rejects paths that contain ".."', async () => {
    await expect(saveDocument('session1', '../escape', new LoroDoc())).rejects.toThrow(
      'Invalid path',
    )
    await expect(loadDocument('session1', '../../etc/passwd')).rejects.toThrow('Invalid path')
    // DOCUMENT_PATH_SEGMENT_PATTERN also rejects dots inside a segment such as `foo.bar/baz`.
    await expect(saveDocument('session1', 'foo/.hidden', new LoroDoc())).rejects.toThrow(
      'Invalid path',
    )
  })

  it('rejects paths that contain dots', async () => {
    await expect(saveDocument('session1', 'foo.bar', new LoroDoc())).rejects.toThrow('Invalid path')
    await expect(saveDocument('session1', '.hidden', new LoroDoc())).rejects.toThrow('Invalid path')
  })

  it('rejects paths that contain spaces', async () => {
    await expect(saveDocument('session1', 'my canvas', new LoroDoc())).rejects.toThrow(
      'Invalid path',
    )
  })

  it('rejects empty paths', async () => {
    await expect(saveDocument('session1', '', new LoroDoc())).rejects.toThrow('Invalid path')
  })

  it('rejects paths that end with a hyphen', async () => {
    await expect(saveDocument('session1', 'canvas-', new LoroDoc())).rejects.toThrow('Invalid path')
  })

  it('rejects path-traversal workspaceIds', async () => {
    await expect(saveDocument('..', 'safe-path', new LoroDoc())).rejects.toThrow(
      'Invalid workspaceId',
    )
    await expect(loadDocument('../escape', 'safe-path')).rejects.toThrow('Invalid workspaceId')
  })

  it('rejects workspaceIds that contain slashes', async () => {
    await expect(saveDocument('nested/session', 'safe-path', new LoroDoc())).rejects.toThrow(
      'Invalid workspaceId',
    )
    await expect(listDocuments('nested/session')).rejects.toThrow('Invalid workspaceId')
  })
})

// Path validation error messages should identify the exact segment and reason.
describe('path validation - self-describing error messages', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('identifies the offending segment and reason for dots', async () => {
    // The failing segment is ".hidden" and the reason is "contains '.'".
    await expect(saveDocument('session1', 'foo/.hidden', new LoroDoc())).rejects.toThrow(
      /segment "\.hidden".*contains '\.'/,
    )
  })

  it('reports whitespace as the reason for segments with spaces', async () => {
    await expect(saveDocument('session1', 'my canvas', new LoroDoc())).rejects.toThrow(
      /segment "my canvas".*whitespace/,
    )
  })

  it('describes a leading slash as an empty segment with slash guidance', async () => {
    await expect(saveDocument('session1', '/foo', new LoroDoc())).rejects.toThrow(
      /empty segment.*leading\/trailing\/consecutive.*\//,
    )
  })

  it('uses the same empty-segment message for consecutive slashes', async () => {
    await expect(saveDocument('session1', 'a//b', new LoroDoc())).rejects.toThrow(/empty segment/)
  })

  it('reports "path is empty" for an empty path', async () => {
    await expect(saveDocument('session1', '', new LoroDoc())).rejects.toThrow(/path is empty/)
  })

  it('reports "leading hyphen" for segments that start with a hyphen', async () => {
    await expect(saveDocument('session1', '-canvas', new LoroDoc())).rejects.toThrow(
      /segment "-canvas".*leading hyphen/,
    )
  })

  it('reports "trailing hyphen" for segments that end with a hyphen', async () => {
    await expect(saveDocument('session1', 'canvas-', new LoroDoc())).rejects.toThrow(
      /segment "canvas-".*trailing hyphen/,
    )
  })

  it('applies the generic dot rule to ".." segments', async () => {
    // ".." is caught by the normal dot rule, so no special-case message is needed.
    await expect(saveDocument('session1', '../escape', new LoroDoc())).rejects.toThrow(
      /segment "\.\.".*contains '\.'/,
    )
  })

  it('reports "invalid character" for non-ASCII characters', async () => {
    // Normal spaces map to the whitespace case, but non-ASCII characters need a separate message.
    await expect(saveDocument('session1', 'café', new LoroDoc())).rejects.toThrow(
      /segment "café".*invalid character/,
    )
  })

  it('includes the full path in the error message for context', async () => {
    await expect(saveDocument('session1', 'valid-top/.bad', new LoroDoc())).rejects.toThrow(
      /"valid-top\/\.bad"/,
    )
  })
})

describe('listWorkspaces', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('lists workspaces seeded via saveDocument', async () => {
    await saveDocument('session-active', 'a', new LoroDoc())
    await saveDocument('session-old', 'a', new LoroDoc())

    const workspaces = await listWorkspaces()
    const ids = workspaces.map((s) => s.workspaceId)
    expect(ids).toContain('session-active')
    expect(ids).toContain('session-old')
  })

  it('returns an empty array when no workspaces have been saved yet', async () => {
    const workspaces = await listWorkspaces()
    expect(workspaces).toHaveLength(0)
  })

  // listWorkspaces is now backed by the workspaces table, so the previous
  // "non-directory DATA_DIR" corruption check no longer applies.
})

// ADR-0019: the daemon's own DocumentIndex (CacheCoherentDocumentIndex) is
// the first implementation that PERSISTS and SERVES segment/displayName —
// the shared ports conformance suite deliberately stays accept-and-ignore,
// so this echo/validation/conflict/non-clobber coverage lives here.
describe('createWorkspace — ADR-0019 identity (segment/displayName)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-identity-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('echoes stored segment and displayName back through listWorkspaces', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({
      workspaceId: 'ws-echo',
      segment: 'team-notes',
      displayName: 'Team notes',
    })

    const rows = await deps.documentIndex.listWorkspaces()
    const row = rows.find((r) => r.workspaceId === 'ws-echo')
    expect(row).toEqual({
      workspaceId: 'ws-echo',
      segment: 'team-notes',
      displayName: 'Team notes',
    })
  })

  it('a legacy workspace with no identity lists with the keys absent, not null', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-legacy' })

    const rows = await deps.documentIndex.listWorkspaces()
    const row = rows.find((r) => r.workspaceId === 'ws-legacy')
    expect(row).toEqual({ workspaceId: 'ws-legacy' })
  })

  it('a bare re-create (the wb_document_create createWorkspace:true path) does not clobber stored identity', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({
      workspaceId: 'ws-preserved',
      segment: 'kept',
      displayName: 'Kept',
    })

    // Every wbDocumentCreate({ createWorkspace: true }) call reaches this
    // bare shape — the identity claimed above must survive it.
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-preserved' })

    const rows = await deps.documentIndex.listWorkspaces()
    const row = rows.find((r) => r.workspaceId === 'ws-preserved')
    expect(row).toEqual({ workspaceId: 'ws-preserved', segment: 'kept', displayName: 'Kept' })
  })

  it('re-creating with identical fields is idempotent', async () => {
    const deps = await getDefaultServerDeps()
    const input = { workspaceId: 'ws-idem', segment: 'idem', displayName: 'Idem' }
    await deps.documentIndex.createWorkspace(input)
    await expect(deps.documentIndex.createWorkspace(input)).resolves.toBeUndefined()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-idem')).toEqual(input)
  })

  it('a second workspace claiming an already-taken segment is refused, and neither row is left partial', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-first', segment: 'contested' })

    const err = await deps.documentIndex
      .createWorkspace({ workspaceId: 'ws-second', segment: 'contested' })
      .catch((e: unknown) => e)
    expect(isWorkspaceSegmentTakenError(err)).toBe(true)

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-second')).toBeUndefined()
    expect(rows.find((r) => r.workspaceId === 'ws-first')).toEqual({
      workspaceId: 'ws-first',
      segment: 'contested',
    })
  })

  // The inbound half of zod-schema-discipline: what listWorkspaces serves
  // was validated on write, so the strict outbound workspaceSummarySchema
  // never meets a poisoned row.
  it('rejects a ULID-shaped segment at the boundary, before any row is written', async () => {
    const deps = await getDefaultServerDeps()
    await expect(
      deps.documentIndex.createWorkspace({
        workspaceId: 'ws-rejected',
        segment: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).rejects.toThrow()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-rejected')).toBeUndefined()
  })

  it('rejects an empty displayName at the boundary, before any row is written', async () => {
    const deps = await getDefaultServerDeps()
    await expect(
      deps.documentIndex.createWorkspace({ workspaceId: 'ws-rejected-2', displayName: '' }),
    ).rejects.toThrow()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-rejected-2')).toBeUndefined()
  })
})

describe('compactDocument', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-compact-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('does not compact when no version exists', async () => {
    const doc = new LoroDoc()
    doc.getMovableList('elements').insert(0, 'x')
    doc.commit()
    await saveDocument('session1', 'test', doc)

    const store = new FileVersionStore()
    const result = await compactDocument('session1', 'test', store)
    expect(result.compacted).toBe(false)
    expect(result.reason).toBe('no-versions')
  })

  it('returns no-file when the .loro file is missing', async () => {
    const store = new FileVersionStore()
    const result = await compactDocument('session1', 'missing', store)
    expect(result).toEqual({ compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' })
  })

  // canvas blobs no longer share their parent directory with the session
  // dir, so the previous "non-directory parent" stat failure no longer
  // applies. Coverage of the corrupt-snapshot branch lives below.

  it('treats an invalid workspace record as corruption instead of compacting over it', async () => {
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')
    const { _clearWorkspaceDocCacheForTests } = await import('./document-store.js')
    const doc = new LoroDoc()
    const store = new FileVersionStore()
    await saveDocument('session1', 'broken', doc)
    await store.save('session1', 'broken', doc, { auto: true })
    const db = await getDb(tempDir)
    // Corrupt the workspace record's snapshot rows directly — the
    // beforeBytes read succeeds (the header is intact), but re-opening the
    // live workspace document decodes the garbage bytes and must surface
    // corruption rather than silently compacting an empty document over
    // real data.
    const libsqlStore = new LibsqlDocumentStore(db)
    const { manifest, chunks } = chunkSnapshot(Buffer.from('not-a-loro-snapshot'), 1_000_000)
    await libsqlStore.saveSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: 'session1' },
      manifest,
      chunks,
      frontier: new Uint8Array(),
    })
    _clearWorkspaceDocCacheForTests()

    await expect(compactDocument('session1', 'broken', store)).rejects.toThrow()
  })

  it('compacts at a version cut point while keeping restore working', async () => {
    const { LoroMap } = await import('loro-crdt')
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    // Build a larger op log by repeatedly adding and updating elements.
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `elem-${i}`)
      m.set('x', i)
    }
    doc.commit()
    await saveDocument('session1', 'test', doc)

    const store = new FileVersionStore()
    const v = await store.save('session1', 'test', doc, { auto: true })

    // Add more operations after the saved version.
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `extra-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'test', doc, { overwrite: true })

    const result = await compactDocument('session1', 'test', store)
    expect(result.compacted).toBe(true)
    expect(result.afterBytes).toBeLessThan(result.beforeBytes)

    // The live state should still have all 60 elements after compaction.
    const live = await loadDocument('session1', 'test')
    expect(live.getMovableList('elements').length).toBe(60)

    // Restoring the oldest version should still work at the cut point.
    const past = await store.load('session1', v.id, live)
    expect(past).not.toBeNull()
    expect(past!.getMovableList('elements').length).toBe(30)

    // Compaction prunes history, not state, so the frontier written for the
    // shallow workspace record must still match the live workspace doc's
    // current oplog version — later saves keep appending from it.
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { getWorkspaceDoc } = await import('./document-store.js')
    const db = await getDb(tempDir)
    const libsqlStore = new LibsqlDocumentStore(db)
    const frontierResult = await libsqlStore.readFrontier({
      docRef: { kind: 'workspace-tree', workspaceId: 'session1' },
    })
    const workspaceDoc = await getWorkspaceDoc('session1')
    expect(frontierResult?.frontier).toEqual(workspaceDoc.oplogVersion().encode())
  })

  it('writes lastCompactedAt only on successful compaction', async () => {
    const { LoroMap } = await import('loro-crdt')

    async function readLastCompactedAt(_path: string): Promise<number | null> {
      // Workspace-level meta (S4b/S7): compaction folds the workspace
      // record, so there is one stamp per workspace, not per document.
      const { openWorkspaceDocIfStored } = await import('./document-store.js')
      const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')
      const workspaceDoc = await openWorkspaceDocIfStored('session1')
      if (workspaceDoc === null) return null
      return readWorkspaceMeta(workspaceDoc).lastCompactedAt ?? null
    }

    // Case 1: no version → reason='no-versions' → lastCompactedAt stays null.
    const empty = new LoroDoc()
    empty.getMovableList('elements').insert(0, 'x')
    empty.commit()
    await saveDocument('session1', 'untouched', empty)
    const noopStore = new FileVersionStore()
    const noop = await compactDocument('session1', 'untouched', noopStore)
    expect(noop.reason).toBe('no-versions')
    expect(await readLastCompactedAt('untouched')).toBeNull()

    // Case 2: version cut available → reason='ok' → lastCompactedAt is set.
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `elem-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'big', doc)
    const store = new FileVersionStore()
    await store.save('session1', 'big', doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `extra-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'big', doc, { overwrite: true })

    const before = Date.now()
    const result = await compactDocument('session1', 'big', store)
    expect(result.compacted).toBe(true)
    const after = Date.now()
    const stamp = await readLastCompactedAt('big')
    expect(stamp).not.toBeNull()
    expect(stamp!).toBeGreaterThanOrEqual(before)
    expect(stamp!).toBeLessThanOrEqual(after)

    // Workspace-level mirror (dual-plane collapse S4b): compaction operates
    // on the workspace record's oplog, so the shared timestamp lives on the
    // workspace meta — and only successful compaction writes it, same as the
    // row stamp ('untouched' compacted nothing above).
    const { openWorkspaceDocIfStored } = await import('./document-store.js')
    const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')
    const workspaceDoc = await openWorkspaceDocIfStored('session1')
    expect(workspaceDoc).not.toBeNull()
    if (workspaceDoc === null) throw new Error('unreachable')
    const wsStamp = readWorkspaceMeta(workspaceDoc).lastCompactedAt
    expect(wsStamp).toBeGreaterThanOrEqual(before)
    expect(wsStamp).toBeLessThanOrEqual(after)
  })

  // compactDocument reads the workspace record, exports the shallow
  // snapshot from the live workspace doc, and writes it back — all under the
  // workspace write lock, the same lock every content writer holds. A
  // concurrent tool write therefore lands strictly before or strictly after
  // the fold, and survives either way.
  it('does not lose a concurrent tool write racing the compaction', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { resolveDocumentIdAtPath } = await import('./document-store.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { WorkspaceRoutedDocumentStore } = await import('./workspace-plane.js')
    const { chunkSnapshot, reassembleSnapshot } = await import('@kamiazya/whiteboard-ports')

    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `elem-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'test', doc)

    const store = new FileVersionStore()
    await store.save('session1', 'test', doc, { auto: true })

    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `extra-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'test', doc, { overwrite: true })

    const db = await getDb(getDataDir())
    const documentId = (await resolveDocumentIdAtPath('session1', 'test'))!

    // Hold the cut lookup open so the tool write races into compaction's
    // window instead of trivially serializing before it.
    const delayedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await new Promise((r) => setTimeout(r, 60))
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const compactPromise = compactDocument('session1', 'test', delayedStore)
    await new Promise((r) => setTimeout(r, 20))
    const routed = new WorkspaceRoutedDocumentStore(new LibsqlDocumentStore(db))
    const docRef = { kind: 'document' as const, workspaceId: 'session1', documentId }
    const existing = await routed.loadSnapshot({ docRef })
    const toolDoc = new LoroDoc()
    toolDoc.import(reassembleSnapshot(existing!.manifest, existing!.chunks))
    toolDoc.getMap('root').set('agentMarker', 'concurrent-edit')
    toolDoc.commit()
    const chunked = chunkSnapshot(new Uint8Array(toolDoc.export({ mode: 'snapshot' })), 1_000_000)
    const toolWrite = routed.saveSnapshot({
      docRef,
      manifest: chunked.manifest,
      chunks: chunked.chunks,
      frontier: new Uint8Array(toolDoc.oplogVersion().encode()),
    })

    await Promise.all([compactPromise, toolWrite])

    const after = await loadDocument('session1', 'test')
    expect(after.getMap('root').get('agentMarker')).toBe('concurrent-edit')
    expect(after.getMovableList('elements').length).toBe(60)
  })
})

// `document-store.deleteDocument` is gone: it was a second implementation of
// `wb_document_delete`, and the HTTP route that called it is now an adapter
// over the operation (ADR-0018). These cases are storage-level — blobs,
// thumbnails, rows, the descendant refusal — so they stay at this layer and
// drive the surviving implementation instead.
//
// The local helper is the ROUTE's translation, written once here rather than
// at each call below: this surface addresses a document by path and answers
// `false` for one that does not exist, where the operation addresses it by
// the id the index assigned and throws. Everything else the cases assert is
// unchanged, which is the point — the implementation moved, the behaviour
// did not.
async function deleteDocument(workspaceId: string, path: string): Promise<boolean> {
  const deps = await getDefaultServerDeps()
  // The tree index throws for an unknown WORKSPACE where the retired SQL
  // index answered null; the route's translation treats both as absent.
  const entry = await deps.documentIndex
    .resolveDocument({ workspaceId, path })
    .catch((err: unknown) => {
      if (isWorkspaceNotFoundError(err)) return null
      throw err
    })
  if (entry === null) return false
  await wbDocumentDelete(deps, { workspaceId, documentId: entry.documentId })
  return true
}

describe('deleting a document', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-delete-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  // The MCP surface already refuses this, and for a stated reason: deletion
  // is the operation with nothing to undo it, so the caller has to name what
  // it is destroying. The HTTP surface deleting the same document silently
  // strands every child under a prefix nothing owns.
  it('refuses to delete a document that still has descendants', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/child', new LoroDoc())

    await expect(deleteDocument('session1', 'a')).rejects.toThrow(DocumentHasDescendantsError)

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/child'])
  })

  it('deletes a document whose name merely prefixes a sibling', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a-sibling', new LoroDoc())

    await expect(deleteDocument('session1', 'a')).resolves.toBe(true)

    expect((await listDocuments('session1')).map((c) => c.path)).toEqual(['a-sibling'])
  })

  it('removes the tree entry, deletes branches/versions rows explicitly, and unlinks the version thumbnail PNGs, leaving the workspace row and a sibling canvas untouched', async () => {
    const { getDb } = await import('./db/index.js')
    const { createBranch } = await import('./branches-store.js')
    const { stat } = await import('node:fs/promises')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

    const doc = new LoroDoc()
    await saveDocument('session1', 'canvas-a', doc)
    await saveDocument('session1', 'canvas-b', doc)
    const store = new FileVersionStore()
    const version = await store.save('session1', 'canvas-a', doc, { auto: true })
    await store.saveThumbnail('session1', version.id, new Uint8Array([1, 2, 3]))
    await createBranch('session1', 'canvas-a', { name: 'feature' })

    const db = await getDb(tempDir)
    const { resolveDocumentIdAtPath } = await import('./document-store.js')
    const documentId = await resolveDocumentIdAtPath('session1', 'canvas-a')
    if (documentId === null) throw new Error('document missing from the tree')
    const libsqlStore = new LibsqlDocumentStore(db)

    const thumbPath = join(tempDir, 'blobs', 'session1', 'versions', `${version.id}.png`)
    await expect(stat(thumbPath)).resolves.toBeDefined()

    await expect(deleteDocument('session1', 'canvas-a')).resolves.toBe(true)

    const branchesAfter = await db
      .selectFrom('branches')
      .selectAll()
      .where('documentId', '=', documentId)
      .execute()
    expect(branchesAfter).toEqual([])
    const versionsAfter = await db
      .selectFrom('versions')
      .selectAll()
      .where('documentId', '=', documentId)
      .execute()
    expect(versionsAfter).toEqual([])

    // Content now lives in the workspace record: the tree node is gone and
    // the bytes were EVACUATED into the trash, not destroyed.
    const { DocumentStoreWorkspaceDocs } = await import('@kamiazya/whiteboard-workspace-index')
    const { resolveWorkspaceDocumentById, readTrashEntries } = await import(
      '@kamiazya/whiteboard-loro-adapter'
    )
    const stored = await new DocumentStoreWorkspaceDocs(libsqlStore).open('session1')
    expect(stored).not.toBeNull()
    expect(resolveWorkspaceDocumentById(stored!, documentId)).toBeNull()
    expect(readTrashEntries(stored!).map((t) => t.documentId)).toContain(documentId)
    await expect(stat(thumbPath)).rejects.toThrow()

    const wsRow = await db
      .selectFrom('workspaces')
      .select(['id'])
      .where('id', '=', 'session1')
      .executeTakeFirst()
    expect(wsRow).toBeDefined()
    // The sibling lives in the tree (documents rows retired with the
    // dual-plane collapse), so "untouched" is a listing fact.
    expect((await listDocuments('session1')).map((c) => c.path)).toEqual(['canvas-b'])
  })

  // The defect this closes: wb_document_delete removed the index row and the
  // Libsql bytes and stopped there, so a document an agent deleted left its
  // thumbnails, its blob and a cached doc instance behind — while the same
  // document deleted through the HTTP route did not. Both paths now run the
  // same teardown, and this asserts on the FILES, not on the tool answering
  // { deleted: true }, which it did throughout the whole defect.
  it('leaves the same state when the delete comes through wb_document_delete as through the HTTP path', async () => {
    const { getDb } = await import('./db/index.js')
    const { stat } = await import('node:fs/promises')
    const { wbDocumentDelete } = await import('@kamiazya/whiteboard-server-core')
    const { LoroWorkspaceDocumentIndex } = await import('@kamiazya/whiteboard-workspace-index')
    const { FsBlobStore } = await import('./fs/fs-blob-store.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { peekDoc } = await import('./doc-cache.js')
    const { cacheBackedWorkspaceDocs, documentTeardown, resolveDocumentIdAtPath } = await import(
      './document-store.js'
    )

    const doc = new LoroDoc()
    await saveDocument('session1', 'agent-deleted', doc)
    const store = new FileVersionStore()
    const version = await store.save('session1', 'agent-deleted', doc, { auto: true })
    await store.saveThumbnail('session1', version.id, new Uint8Array([1, 2, 3]))
    // Populate the doc cache the way a read would, so eviction has something
    // to evict — otherwise this half of the assertion passes vacuously.
    // getDoc, not loadDocument: only the former goes through the LRU.
    const { getDoc } = await import('./document-store.js')
    await getDoc('session1', 'agent-deleted')
    expect(peekDoc('session1', 'agent-deleted')).toBeDefined()

    const db = await getDb(tempDir)
    const documentId = await resolveDocumentIdAtPath('session1', 'agent-deleted')
    expect(documentId).not.toBeNull()
    if (documentId === null) throw new Error('unreachable')
    const thumbPath = join(tempDir, 'blobs', 'session1', 'versions', `${version.id}.png`)
    await expect(stat(thumbPath)).resolves.toBeDefined()

    await wbDocumentDelete(
      {
        documentStore: new LibsqlDocumentStore(db),
        blobStore: {} as never,
        documentIndex: new LoroWorkspaceDocumentIndex(
          cacheBackedWorkspaceDocs(),
          new FsBlobStore(join(tempDir, 'blobs')),
        ),
        documentTeardown,
      },
      { workspaceId: 'session1', documentId },
    )

    await expect(stat(thumbPath)).rejects.toThrow()
    expect(peekDoc('session1', 'agent-deleted')).toBeUndefined()
    expect(await resolveDocumentIdAtPath('session1', 'agent-deleted')).toBeNull()
  })

  it('returns false for a missing canvas without throwing; deleting the same canvas twice returns true then false', async () => {
    await expect(deleteDocument('session1', 'ghost')).resolves.toBe(false)

    await saveDocument('session1', 'once', new LoroDoc())
    await expect(deleteDocument('session1', 'once')).resolves.toBe(true)
    await expect(deleteDocument('session1', 'once')).resolves.toBe(false)
  })

  it('deletes a canvas that never had an FS blob (nothing writes one post-collapse)', async () => {
    // saveDocument never writes an FS blob — content lives entirely in the
    // workspace record's Libsql-backed bytes.
    await saveDocument('session1', 'row-only', new LoroDoc())

    await expect(deleteDocument('session1', 'row-only')).resolves.toBe(true)
    expect(
      await (await import('./document-store.js')).resolveDocumentIdAtPath('session1', 'row-only'),
    ).toBeNull()
  })
})

describe('renameDocumentPath', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-rename-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('moves only the path: branches/versions rows and the Libsql snapshot stay byte-identical and keyed to the same documentId', async () => {
    const { getDb } = await import('./db/index.js')
    const { createBranch, loadDocumentBranches } = await import('./branches-store.js')

    const doc = new LoroDoc()
    await saveDocument('session1', 'a', doc)
    await createBranch('session1', 'a', { name: 'feature' })
    const store = new FileVersionStore()
    const version = await store.save('session1', 'a', doc, { auto: true })

    const db = await getDb(tempDir)
    const beforeId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      'session1',
      'a',
    )
    if (beforeId === null) throw new Error('document missing from the tree')
    const before = { id: beforeId }
    const documentId = before.id
    const contentBefore = (await loadDocument('session1', 'a')).toJSON()

    await expect(renameDocumentPath('session1', 'a', 'b')).resolves.toEqual({ documentId })

    const list = await listDocuments('session1')
    expect(list.map((c) => c.path)).toEqual(['b'])

    const afterId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      'session1',
      'b',
    )
    if (afterId === null) throw new Error('document missing from the tree')
    const after = { id: afterId }
    expect(after.id).toBe(documentId)

    const branchesAfter = await db
      .selectFrom('branches')
      .selectAll()
      .where('documentId', '=', documentId)
      .execute()
    expect(branchesAfter.map((b) => b.name).sort()).toEqual(['feature', 'main'])

    const versionsAfter = await db
      .selectFrom('versions')
      .selectAll()
      .where('documentId', '=', documentId)
      .execute()
    expect(versionsAfter.map((v) => v.id)).toEqual([version.id])

    // Content is untouched by the move — same documentId, same value.
    expect((await loadDocument('session1', 'b')).toJSON()).toEqual(contentBefore)

    // loadDocumentBranches also resolves under the new path.
    const branches = await loadDocumentBranches('session1', 'b')
    expect(branches.branches.map((b) => b.name).sort()).toEqual(['feature', 'main'])
  })

  it('returns null (never throws) for a missing source canvas', async () => {
    await expect(renameDocumentPath('session1', 'ghost', 'somewhere')).resolves.toBeNull()
  })

  it('throws ConflictError for an already-taken target path and mutates neither canvas', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'b', new LoroDoc())

    await expect(renameDocumentPath('session1', 'a', 'b')).rejects.toThrow(ConflictError)

    const list = await listDocuments('session1')
    expect(list.map((c) => c.path).sort()).toEqual(['a', 'b'])
  })

  it('throws the path validator error for an invalid target path', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await expect(renameDocumentPath('session1', 'a', '../evil')).rejects.toThrow()
  })

  it('rename to the SAME path is a no-op success, returning the existing documentId', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    const { getDb } = await import('./db/index.js')
    const _db = await getDb(tempDir)
    const beforeId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      'session1',
      'a',
    )
    if (beforeId === null) throw new Error('document missing from the tree')
    const before = { id: beforeId }

    await expect(renameDocumentPath('session1', 'a', 'a')).resolves.toEqual({
      documentId: before.id,
    })

    const list = await listDocuments('session1')
    expect(list.map((c) => c.path)).toEqual(['a'])
  })

  // A path IS the hierarchy, so renaming one carries everything under it.
  // Moving only the named row leaves its children addressed below a prefix
  // no document owns — reachable by nothing the UI can show, and produced by
  // the ordinary act of renaming a group.
  it('carries every descendant with the renamed path', async () => {
    await saveDocument('session1', 'design', new LoroDoc())
    await saveDocument('session1', 'design/login', new LoroDoc())
    await saveDocument('session1', 'design/deep/notes', new LoroDoc())
    await saveDocument('session1', 'designs-elsewhere', new LoroDoc())

    await renameDocumentPath('session1', 'design', 'product')

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['designs-elsewhere', 'product', 'product/deep/notes', 'product/login'])
  })

  // The prefix test above would pass with a blind string replace; this one
  // fails unless the rewrite is anchored at a segment boundary.
  it('does not carry a sibling that merely shares the name as a prefix', async () => {
    await saveDocument('session1', 'design', new LoroDoc())
    await saveDocument('session1', 'design-system', new LoroDoc())

    await renameDocumentPath('session1', 'design', 'product')

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['design-system', 'product'])
  })

  // The one rule `planSubtreeMove` deliberately does NOT enforce, so each
  // caller has to. Without it the depth-ordered write — correct for the
  // upward move it was written for — is inverted, and the shallow row lands
  // on a path its own descendant has not vacated yet.
  it('refuses to move a document inside itself rather than raising a raw constraint error', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/x', new LoroDoc())

    await expect(renameDocumentPath('session1', 'a', 'a/x')).rejects.toThrow(
      DocumentMoveIntoSelfError,
    )

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/x'])
  })

  it('refuses to nest a document inside itself even when the destination is free', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/b', new LoroDoc())

    await expect(renameDocumentPath('session1', 'a', 'a/nested')).rejects.toThrow(
      DocumentMoveIntoSelfError,
    )

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/b'])
  })

  it('rejects a rename that would collide with an existing descendant path', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/x', new LoroDoc())
    await saveDocument('session1', 'c/x', new LoroDoc())

    // `a` -> `c` is free at the top, and still collides: `a/x` would land on
    // the occupied `c/x`.
    await expect(renameDocumentPath('session1', 'a', 'c')).rejects.toThrow(ConflictError)

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/x', 'c/x'])
  })

  it('evicts every moved path from the cache, not only the two named ones', async () => {
    const { peekDoc, clearCache } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')
    clearCache()
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/child', new LoroDoc())
    await getDoc('session1', 'a/child')
    expect(peekDoc('session1', 'a/child')).not.toBeUndefined()

    await renameDocumentPath('session1', 'a', 'b')

    // A stale instance cached under the old child path would be resurrected
    // by the next read through it, shadowing the moved document.
    expect(peekDoc('session1', 'a/child')).toBeUndefined()
  })

  it('evicts the old cache key so a subsequent getDoc under the old path misses the cache', async () => {
    const { peekDoc, clearCache } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')
    clearCache()
    try {
      await saveDocument('session1', 'a', new LoroDoc())
      await getDoc('session1', 'a')
      expect(peekDoc('session1', 'a')).toBeDefined()

      await renameDocumentPath('session1', 'a', 'b')
      expect(peekDoc('session1', 'a')).toBeUndefined()
    } finally {
      clearCache()
    }
  })

  it('evicts a phantom doc-cache entry already sitting at the destination path, so the renamed content is not overwritten', async () => {
    const { peekDoc, clearCache } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')
    clearCache()
    try {
      // Write real content under 'a'.
      const doc = new LoroDoc()
      doc.getText('content').insert(0, 'real content')
      doc.commit()
      await saveDocument('session1', 'a', doc)

      // Simulate a WS connect (or update route) against a not-yet-created
      // path 'b': getDoc() lazily caches an empty in-memory doc for it
      // even though there is no DB row yet.
      await getDoc('session1', 'b')
      expect(peekDoc('session1', 'b')).toBeDefined()

      await renameDocumentPath('session1', 'a', 'b')

      // The stale phantom doc must not still shadow the just-renamed
      // canvas's real content at the destination path.
      expect(peekDoc('session1', 'b')).toBeUndefined()

      const reloaded = await getDoc('session1', 'b')
      expect(reloaded.getText('content').toString()).toBe('real content')
    } finally {
      clearCache()
    }
  })
})

describe('auto-compact', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-auto-compact-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    uninstallAutoCompact()
    await disposeAutoCompact()
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saveDocument notifies the registered document-saved listener', async () => {
    const trigger = vi.fn<(workspaceId: string, path: string) => void>()
    setDocumentSavedListener(trigger)
    await saveDocument('session1', 'foo', new LoroDoc())
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith('session1', 'foo')
  })

  it('scheduleAutoCompact debounces rapid triggers into a single compaction', async () => {
    const { LoroMap } = await import('loro-crdt')

    async function readLastCompactedAt(): Promise<number | null> {
      const { openWorkspaceDocIfStored } = await import('./document-store.js')
      const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')
      const workspaceDoc = await openWorkspaceDocIfStored('session1')
      if (workspaceDoc === null) return null
      return readWorkspaceMeta(workspaceDoc).lastCompactedAt ?? null
    }

    // Build a canvas with a version cut + extra ops so compactDocument
    // actually has work to do (otherwise the debounced firing would
    // just return reason: 'no-versions' and lastCompactedAt stays null).
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `e-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'big', doc)
    const store = new FileVersionStore()
    await store.save('session1', 'big', doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `x-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'big', doc, { overwrite: true })

    expect(await readLastCompactedAt()).toBeNull()

    // Three rapid triggers within the debounce window must collapse into
    // a single compactDocument run. Use a tiny debounce so the test stays fast.
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 50 })
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 50 })
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 50 })

    // Nothing has fired yet.
    expect(await readLastCompactedAt()).toBeNull()

    // Wait past the debounce + the async compactDocument write. Poll instead of
    // a fixed sleep so this does not flake on a slow CI runner.
    const stamp = await vi.waitFor(
      async () => {
        const value = await readLastCompactedAt()
        expect(value).not.toBeNull()
        return value
      },
      { timeout: 2000 },
    )
    const settled = stamp!

    // Further idle time without a new trigger must NOT re-compact. This half
    // is an inherently bounded negative wait — keep it real rather than
    // deleting the assertion.
    await new Promise((r) => setTimeout(r, 150))
    expect(await readLastCompactedAt()).toBe(settled)
  })

  it('keeps the cached doc coherent through an auto-compact — the next save does not clobber the compacted record', async () => {
    // The legacy trap was a cached full doc re-exporting its entire history
    // over a freshly shallowed record. The workspace record's compaction
    // writes its OWN live doc's frontier, so the cache needs no eviction —
    // this pins that a post-compact edit round-trips instead of resurrecting
    // pre-compact bytes or losing the edit.
    const { LoroMap } = await import('loro-crdt')
    const { peekDoc, clearCache } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')

    clearCache()

    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `e-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'cached', doc)
    const store = new FileVersionStore()
    await store.save('session1', 'cached', doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `x-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'cached', doc, { overwrite: true })

    await getDoc('session1', 'cached')
    expect(peekDoc('session1', 'cached')).toBeDefined()

    scheduleAutoCompact('session1', 'cached', store, { debounceMs: 50 })
    await vi.waitFor(
      async () => {
        const { openWorkspaceDocIfStored } = await import('./document-store.js')
        const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')
        const workspaceDoc = await openWorkspaceDocIfStored('session1')
        expect(
          workspaceDoc && (readWorkspaceMeta(workspaceDoc).lastCompactedAt ?? null),
        ).not.toBeNull()
      },
      { timeout: 2000 },
    )

    // Edit and save AFTER the compaction, then reload from stored bytes
    // only: everything survives.
    const live = await getDoc('session1', 'cached')
    live.getMap('root').set('post-compact', 'edit')
    live.commit()
    await saveDocument('session1', 'cached', live, { overwrite: true })
    const { _clearWorkspaceDocCacheForTests } = await import('./document-store.js')
    clearCache()
    _clearWorkspaceDocCacheForTests()
    const reloaded = await loadDocument('session1', 'cached')
    expect(reloaded.getMovableList('elements').length).toBe(60)
    expect(reloaded.getMap('root').get('post-compact')).toBe('edit')
  })
})

describe('auto-compact disposal', () => {
  let disposedDb = false

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-auto-compact-dispose-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    disposedDb = false
  })

  afterEach(async () => {
    uninstallAutoCompact()
    await disposeAutoCompact()
    if (!disposedDb) {
      await teardownIsolatedDb()
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  async function buildCompactableCanvas(
    path: string,
  ): Promise<InstanceType<typeof FileVersionStore>> {
    const { LoroMap } = await import('loro-crdt')
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `e-${i}`)
    }
    doc.commit()
    await saveDocument('session1', path, doc)
    const store = new FileVersionStore()
    await store.save('session1', path, doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `x-${i}`)
    }
    doc.commit()
    await saveDocument('session1', path, doc, { overwrite: true })
    return store
  }

  // compactDocument normally settles fast enough (in-memory DB, tiny fixture)
  // that polling for "in flight" would race the compaction to zero. Delay
  // just the cut lookup — an await compactDocument makes early on — so tests
  // can deterministically observe the in-flight window instead of depending
  // on real-clock luck.
  function withDelayedEarliestFrontiers(
    store: InstanceType<typeof FileVersionStore>,
    delayMs: number,
  ): InstanceType<typeof FileVersionStore> {
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await new Promise((r) => setTimeout(r, delayMs))
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }

  it('cancels the pending debounce when the DB is disposed before it fires, instead of touching the destroyed driver', async () => {
    const store = await buildCompactableCanvas('big')
    const logs = captureLogsForTests('warning')

    // Do NOT call uninstallAutoCompact() here — the point of this test
    // is that DB disposal alone (without that manual call) must cancel the
    // pending timer.
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 20 })
    await teardownIsolatedDb()
    disposedDb = true

    // Wait past the debounce window. If the timer was not cancelled, its
    // fired compactDocument call would hit the destroyed driver and log a
    // 'failed' warning.
    await new Promise((r) => setTimeout(r, 150))
    logs.restore()

    const autoCompactRecords = logs.records.filter((r) => r.scope === 'auto-compact')
    expect(autoCompactRecords).toHaveLength(0)
  })

  it('disposeAutoCompact awaits an already-fired in-flight compaction before resolving', async () => {
    const store = await buildCompactableCanvas('cached')

    async function readLastCompactedAt(): Promise<number | null> {
      const { openWorkspaceDocIfStored } = await import('./document-store.js')
      const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')
      const workspaceDoc = await openWorkspaceDocIfStored('session1')
      if (workspaceDoc === null) return null
      return readWorkspaceMeta(workspaceDoc).lastCompactedAt ?? null
    }

    scheduleAutoCompact('session1', 'cached', withDelayedEarliestFrontiers(store, 100), {
      debounceMs: 1,
    })
    await vi.waitFor(
      () => {
        expect(_inFlightAutoCompactCountForTests()).toBeGreaterThan(0)
      },
      { timeout: 2000 },
    )

    await disposeAutoCompact()

    expect(_inFlightAutoCompactCountForTests()).toBe(0)
    expect(await readLastCompactedAt()).not.toBeNull()
  })

  it('disposeAutoCompact refuses a reschedule attempted while disposal is in progress, instead of racing a timer against the next clear pass', async () => {
    const store = await buildCompactableCanvas('reentrant')

    // Simulates loadDocument()'s legacy-migration path resuming mid-compaction
    // and calling saveDocument(), which re-invokes the auto-compact trigger and
    // attempts to schedule a fresh timer. The reschedule is gated on an
    // explicit signal (not a wall-clock delay) so it fires deterministically
    // once _isDisposingAutoCompactForTests() is confirmed true, rather than
    // hoping a fixed sleep lands inside disposeAutoCompact's await window —
    // that race is what made the previous version of this test flaky under
    // load (CI run 29162596104).
    let releaseReschedule: () => void = () => undefined
    const rescheduleGate = new Promise<void>((resolve) => {
      releaseReschedule = resolve
    })
    const rescheduleCallCount = { count: 0 }
    const countingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            rescheduleCallCount.count += 1
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const reentrantStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await rescheduleGate
            scheduleAutoCompact('session1', 'reentrant', countingStore, { debounceMs: 0 })
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    scheduleAutoCompact('session1', 'reentrant', reentrantStore, { debounceMs: 1 })
    await vi.waitFor(
      () => {
        expect(_inFlightAutoCompactCountForTests()).toBeGreaterThan(0)
      },
      { timeout: 2000 },
    )

    const disposePromise = disposeAutoCompact()
    // Confirm disposal has actually begun (and is blocked awaiting the
    // in-flight compaction above) before letting the reschedule proceed —
    // this is the exact interleaving the original bug report depended on
    // luck to hit.
    await vi.waitFor(
      () => {
        expect(_isDisposingAutoCompactForTests()).toBe(true)
      },
      { timeout: 2000 },
    )
    releaseReschedule()
    await disposePromise

    expect(_inFlightAutoCompactCountForTests()).toBe(0)
    // debounceMs: 0 still yields a macrotask tick before firing; give it a
    // chance to fire if it were ever going to, then confirm it didn't.
    await new Promise((r) => setTimeout(r, 20))
    expect(rescheduleCallCount.count).toBe(0)
  })

  it('disposes through the real DB lifecycle (createIsolatedDb().dispose()) without spinning up a replacement connection for a re-entrant getDb() call', async () => {
    const store = await buildCompactableCanvas('lifecycle')
    const { getDb } = await import('./db/index.js')
    let reentrantDb: Awaited<ReturnType<typeof getDb>> | null = null

    const reentrantStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await new Promise((r) => setTimeout(r, 100))
            // Mirrors a compaction resuming and touching the DB again
            // (e.g. via loadDocument()) while teardown is draining hooks.
            reentrantDb = await getDb(tempDir)
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    scheduleAutoCompact('session1', 'lifecycle', reentrantStore, { debounceMs: 1 })
    await vi.waitFor(
      () => {
        expect(_inFlightAutoCompactCountForTests()).toBeGreaterThan(0)
      },
      { timeout: 2000 },
    )

    const disposingDb = handle.db
    // Exercise the actual DB lifecycle API (createIsolatedDb().dispose(),
    // mirroring closeDb() in production) rather than calling
    // disposeAutoCompact() directly, so the cache-removal-vs-hook-ordering
    // fix in db/index.ts is covered from this store's perspective too.
    await teardownIsolatedDb()
    disposedDb = true

    expect(reentrantDb).toBe(disposingDb)
  })

  it('is idempotent, and scheduleAutoCompact still works after a dispose', async () => {
    const store = await buildCompactableCanvas('again')

    async function readLastCompactedAt(): Promise<number | null> {
      const { openWorkspaceDocIfStored } = await import('./document-store.js')
      const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')
      const workspaceDoc = await openWorkspaceDocIfStored('session1')
      if (workspaceDoc === null) return null
      return readWorkspaceMeta(workspaceDoc).lastCompactedAt ?? null
    }

    await disposeAutoCompact()
    await disposeAutoCompact()

    scheduleAutoCompact('session1', 'again', store, { debounceMs: 20 })
    await vi.waitFor(
      async () => {
        expect(await readLastCompactedAt()).not.toBeNull()
      },
      { timeout: 2000 },
    )
  })

  it('composes with uninstallAutoCompact() in either order without dropping in-flight work', async () => {
    const store = await buildCompactableCanvas('composed')

    async function readLastCompactedAt(): Promise<number | null> {
      const { openWorkspaceDocIfStored } = await import('./document-store.js')
      const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')
      const workspaceDoc = await openWorkspaceDocIfStored('session1')
      if (workspaceDoc === null) return null
      return readWorkspaceMeta(workspaceDoc).lastCompactedAt ?? null
    }

    scheduleAutoCompact('session1', 'composed', withDelayedEarliestFrontiers(store, 100), {
      debounceMs: 1,
    })
    await vi.waitFor(
      () => {
        expect(_inFlightAutoCompactCountForTests()).toBeGreaterThan(0)
      },
      { timeout: 2000 },
    )

    // uninstallAutoCompact() stays synchronous and timer-only: it must
    // not swallow the in-flight compaction that is already running.
    uninstallAutoCompact()
    await disposeAutoCompact()

    expect(await readLastCompactedAt()).not.toBeNull()
  })
})
