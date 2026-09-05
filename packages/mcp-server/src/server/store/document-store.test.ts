import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
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
const { saveDocument, loadDocument, listDocuments, renameDocumentPath, getDocumentKind } =
  await import('./document-store.js')
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
