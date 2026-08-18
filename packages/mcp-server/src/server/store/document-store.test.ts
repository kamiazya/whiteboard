import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DocumentHasDescendantsError, DocumentMoveIntoSelfError } from '@kamiazya/whiteboard-ports'
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
  deleteDocument,
  renameDocumentPath,
  ConflictError,
  scheduleAutoCompact,
  setAutoCompactTrigger,
  disposeAutoCompact,
  getDocumentKind,
  _inFlightAutoCompactCountForTests,
  _isDisposingAutoCompactForTests,
} = await import('./document-store.js')
const { captureLogsForTests } = await import('../log.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

async function setupIsolatedDb(): Promise<void> {
  handle = await createIsolatedDb({ dataDir: tempDir })
}

async function teardownIsolatedDb(): Promise<void> {
  await handle.dispose()
}

// Identity-convergence flip: loadDocument/saveDocument must read/write
// through the SAME LibsqlDocumentStore rows the MCP tool surface uses,
// instead of a separate FS blob tree the two paths cannot see into each
// other's writes. RED today: loadDocument still reads only the FS blob, so
// content seeded directly into the Libsql snapshot tables reads back empty.
describe('loadDocument reads through LibsqlDocumentStore (identity-convergence flip)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-flip-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns real content seeded directly into the Libsql snapshot tables, not an empty doc', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { upsertDocumentRow } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')

    const db = await getDb(getDataDir())
    const documentId = await upsertDocumentRow(db, 'session1', 'seeded')

    const seedDoc = new LoroDoc()
    seedDoc.getText('content').insert(0, 'real content')
    seedDoc.commit()
    const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
    const store = new LibsqlDocumentStore(db)
    await store.saveSnapshot({
      docRef: { kind: 'document', documentId },
      manifest,
      chunks,
      frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })

    const loaded = await loadDocument('session1', 'seeded')
    expect(loaded.getText('content').toString()).toBe('real content')
  })

  it('a saveDocument write is immediately visible through LibsqlDocumentStore.loadSnapshot directly', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { getDocumentIdByPath } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { reassembleSnapshot } = await import('@kamiazya/whiteboard-ports')

    const doc = new LoroDoc()
    doc.getText('content').insert(0, 'written via saveDocument')
    doc.commit()
    await saveDocument('session1', 'write-through', doc)

    const db = await getDb(getDataDir())
    const documentId = await getDocumentIdByPath(db, 'session1', 'write-through')
    expect(documentId).not.toBeNull()
    const store = new LibsqlDocumentStore(db)
    const snapshot = await store.loadSnapshot({
      docRef: { kind: 'document', documentId: documentId! },
    })
    expect(snapshot).not.toBeNull()
    const reloaded = new LoroDoc()
    reloaded.import(reassembleSnapshot(snapshot!.manifest, snapshot!.chunks))
    expect(reloaded.getText('content').toString()).toBe('written via saveDocument')
  })
})

// Lock-namespace unification: saveDocument (the HTTP/WS path) and every
// mutating MCP tool now write the SAME LibsqlDocumentStore rows, so they
// must serialize on the SAME per-document queue (workspace-lock.ts's
// withDocumentWriteLock) or one writer's saveSnapshot transaction can land
// concurrently with another's on a single shared db connection. Before the
// flip this was harmless (the two paths wrote disjoint storage); after it,
// it is the same lost-update class canvas-doc-write-lock.test.ts already
// pins for two unserialized MCP calls, now reachable from a THIRD writer
// (saveDocument) that has no lock of its own.
describe('saveDocument nests withDocumentWriteLock (identity-convergence flip)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-lock-race-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('a concurrent saveDocument write is never interleaved into an MCP-tool-style write holding the canvas-doc lock on the same document', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { getDocumentIdByPath } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')
    const { withDocumentWriteLock } = await import('./workspace-lock.js')

    await saveDocument('session1', 'race', new LoroDoc())
    const db = await getDb(getDataDir())
    const documentId = (await getDocumentIdByPath(db, 'session1', 'race'))!
    const docRef = { kind: 'document' as const, documentId }

    // Patch the class prototype (not one instance) so this observes every
    // saveSnapshot call for this document, including document-store.ts's
    // own internally-cached LibsqlDocumentStore instance.
    const events: string[] = []
    const originalSaveSnapshot = LibsqlDocumentStore.prototype.saveSnapshot
    let delayedOnce = false
    LibsqlDocumentStore.prototype.saveSnapshot = async function (
      this: InstanceType<typeof LibsqlDocumentStore>,
      input,
    ) {
      const forThisDoc = input.docRef.kind === 'document' && input.docRef.documentId === documentId
      if (forThisDoc) events.push('save-start')
      // Hold the FIRST save call open (the tool's) so a concurrent,
      // unserialized saveDocument call has a real window to land its own
      // save call before the tool's completes — the exact interleaving
      // the canvas-doc lock exists to rule out.
      if (forThisDoc && !delayedOnce) {
        delayedOnce = true
        await new Promise((r) => setTimeout(r, 50))
      }
      const result = await originalSaveSnapshot.call(this, input)
      if (forThisDoc) events.push('save-end')
      return result
    }

    try {
      const toolWrite = withDocumentWriteLock(documentId, async () => {
        events.push('tool-critical-section-start')
        const libsqlStore = new LibsqlDocumentStore(db)
        const doc = new LoroDoc()
        doc.getMap('root').set('marker', 'tool')
        doc.commit()
        const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
        await libsqlStore.saveSnapshot({
          docRef,
          manifest,
          chunks,
          frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
        })
        events.push('tool-critical-section-end')
      })

      // Give the tool a head start so it acquires the lock and enters its
      // (delayed) save before the HTTP write races in.
      await new Promise((r) => setTimeout(r, 5))
      const httpDoc = new LoroDoc()
      httpDoc.getMap('root').set('marker', 'http')
      httpDoc.commit()
      const httpWrite = saveDocument('session1', 'race', httpDoc, { overwrite: true })

      await Promise.all([toolWrite, httpWrite])
    } finally {
      LibsqlDocumentStore.prototype.saveSnapshot = originalSaveSnapshot
    }

    // Every save-start for this document is either the tool's own single
    // save (inside its critical section) or one that started only AFTER
    // the tool's critical section fully released — never one that started
    // WHILE the tool's save was still in flight (the lost-update/torn-write
    // window this slice's lock unification closes).
    const startIdx = events.indexOf('tool-critical-section-start')
    const endIdx = events.indexOf('tool-critical-section-end')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThan(startIdx)
    const saveStarts = events
      .map((e, i) => [e, i] as const)
      .filter(([e]) => e === 'save-start')
      .map(([, i]) => i)
    expect(saveStarts.length).toBe(2)
    // Exactly one save-start may fall inside the tool's critical section —
    // its own. Any OTHER save-start landing in that same window means a
    // second writer's transaction started while the tool's was still open;
    // the events array records only ARRIVAL order, so without this exact
    // count check two same-window save-starts would each individually look
    // "inside the tool's window" and the loop below would wrongly wave both
    // through.
    const withinToolWindow = saveStarts.filter((i) => i > startIdx && i < endIdx)
    expect(
      withinToolWindow.length,
      `save-start(s) landed inside the tool's critical section: ${JSON.stringify(withinToolWindow)}; events were ${events.join(',')}`,
    ).toBe(1)
    for (const i of saveStarts) {
      if (withinToolWindow.includes(i)) continue
      expect(i, `save-start at index ${i}; events were ${events.join(',')}`).toBeGreaterThan(endIdx)
    }
  })
})

// The lock alone only makes an overwrite ATOMIC — it cannot make it
// correct. doc-cache holds a long-lived LoroDoc that WS frames mutate in
// place; an MCP tool writing the same Libsql rows out of band leaves that
// cached doc stale, and its next save would export the stale state as the
// whole new truth, erasing the agent's ops in one atomic write. The save
// path must MERGE the stored snapshot into the outgoing doc first (a CRDT
// import: known ops are no-ops), so both writers' ops survive.
describe('saveDocument merges an out-of-band write instead of clobbering it', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-merge-save-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('a stale cached doc save preserves ops an MCP-style writer stored since it loaded', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { getDocumentIdByPath } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot, reassembleSnapshot } = await import('@kamiazya/whiteboard-ports')

    // Create, then take the "cached" live doc the WS session would hold.
    const seed = new LoroDoc()
    seed.getMap('nodes').set('base', { id: 'base' })
    seed.commit()
    await saveDocument('session1', 'merge-race', seed, { overwrite: true })
    const live = await loadDocument('session1', 'merge-race')

    // Out-of-band MCP-style write: an independent load-modify-save straight
    // through LibsqlDocumentStore, exactly as server-core's document-io does
    // — the doc-cache (and `live`) never see it.
    const db = await getDb(getDataDir())
    const documentId = (await getDocumentIdByPath(db, 'session1', 'merge-race'))!
    const docRef = { kind: 'document' as const, documentId }
    const store = new LibsqlDocumentStore(db)
    const agentDoc = new LoroDoc()
    const existing = await store.loadSnapshot({ docRef })
    agentDoc.import(reassembleSnapshot(existing!.manifest, existing!.chunks))
    agentDoc.getMap('nodes').set('agent', { id: 'agent' })
    agentDoc.commit()
    const agentSnapshot = agentDoc.export({ mode: 'snapshot' })
    const { manifest, chunks } = chunkSnapshot(agentSnapshot, 1_000_000)
    await store.saveSnapshot({
      docRef,
      manifest,
      chunks,
      frontier: agentDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })

    // The stale cached doc makes its own edit and saves.
    live.getMap('nodes').set('web', { id: 'web' })
    live.commit()
    await saveDocument('session1', 'merge-race', live, { overwrite: true })

    // Both writers' ops must survive in the stored truth.
    const reloaded = await loadDocument('session1', 'merge-race')
    const keys = reloaded.getMap('nodes').keys().sort()
    expect(keys).toEqual(['agent', 'base', 'web'])
  })
})

describe('legacy LoroList -> MovableList migration reads and persists through Libsql (identity-convergence flip)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-legacy-migrate-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('migrates a legacy LoroList doc seeded directly in Libsql, persists the movable list back through saveDocument, and backs up the pre-migration bytes', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { upsertDocumentRow } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')
    const { access } = await import('node:fs/promises')

    const db = await getDb(getDataDir())
    const documentId = await upsertDocumentRow(db, 'session1', 'legacy')

    // Build a legacy doc: elements stored in a plain LoroList, the shape
    // migrateLegacyListToMovable repairs on load. No production code writes
    // this shape any more, so it is constructed directly here.
    const legacyDoc = new LoroDoc()
    const list = legacyDoc.getList('elements')
    const item = list.insertContainer(0, new LoroMap())
    item.set('id', 'legacy-elem')
    item.set('type', 'rectangle')
    legacyDoc.commit()
    const legacyBytes = legacyDoc.export({ mode: 'snapshot' })
    const { manifest, chunks } = chunkSnapshot(legacyBytes, 1_000_000)
    const store = new LibsqlDocumentStore(db)
    await store.saveSnapshot({
      docRef: { kind: 'document', documentId },
      manifest,
      chunks,
      frontier: legacyDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })

    const loaded = await loadDocument('session1', 'legacy')
    const movable = loaded.getMovableList('elements').toJSON() as { id: string; type: string }[]
    expect(movable).toHaveLength(1)
    expect(movable[0].id).toBe('legacy-elem')
    expect(loaded.getList('elements').length).toBe(0)

    // Persisted back through saveDocument (the migration's own side effect):
    // a fresh load must see the movable list, not the legacy shape again.
    const reloaded = await loadDocument('session1', 'legacy')
    const reloadedMovable = reloaded.getMovableList('elements').toJSON() as { id: string }[]
    expect(reloadedMovable).toEqual(movable)

    // Pre-migration bytes were backed up next to the (otherwise unused)
    // blob path, fixing the cwd-relative bak-path bug in the pre-flip code.
    const bakPath = join(
      tempDir,
      'blobs',
      'session1',
      'canvas',
      `${documentId}.loro.pre-migrate-bak`,
    )
    await expect(access(bakPath)).resolves.toBeUndefined()
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

  it("persists the frontier bytes as the doc's own oplog version, readable back via LibsqlDocumentStore.readFrontier", async () => {
    const { getDb } = await import('./db/index.js')
    const { getDocumentIdByPath } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const doc = new LoroDoc()
    doc.getMovableList('elements').insert(0, 'x')
    doc.commit()
    await saveDocument('session1', 'frontier-check', doc)

    const db = await getDb(tempDir)
    const documentId = await getDocumentIdByPath(db, 'session1', 'frontier-check')
    const store = new LibsqlDocumentStore(db)
    const result = await store.readFrontier({
      docRef: { kind: 'document', documentId: documentId! },
    })
    expect(result?.frontier).toEqual(doc.oplogVersion().encode())
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
    const db = await getDb(getDataDir())
    const row = await db
      .selectFrom('documents')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'ulid-mint')
      .executeTakeFirst()
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

  it('throws on broken snapshots instead of returning an empty LoroDoc', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDocumentIdByPath } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')
    await saveDocument('session1', 'broken', new LoroDoc())
    const db = await getDb(tempDir)
    const documentId = await getDocumentIdByPath(db, 'session1', 'broken')
    // Overwrite the Libsql snapshot rows directly with bytes that are not a
    // valid Loro snapshot — the corruption a Libsql-backed store can suffer,
    // now that content no longer lives in an FS blob.
    const store = new LibsqlDocumentStore(db)
    const { manifest, chunks } = chunkSnapshot(Buffer.from('not-a-loro-snapshot'), 1_000_000)
    await store.saveSnapshot({
      docRef: { kind: 'document', documentId: documentId! },
      manifest,
      chunks,
      frontier: new Uint8Array(),
    })

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

  it('omits kind for a row that records none, instead of guessing spatial', async () => {
    // The guess used to escape as stored fact (wb_version_restore forked it
    // into new rows), and no caller could tell "stored as spatial" from
    // "never recorded". An unrecorded kind is now absent, not invented.
    await saveDocument('session1', 'kindless', new LoroDoc())
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const db = await getDb(getDataDir())
    await db
      .updateTable('documents')
      .set({ kind: null })
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'kindless')
      .execute()

    const [entry] = await listDocuments('session1')

    expect(entry?.path).toBe('kindless')
    expect(entry?.kind).toBeUndefined()
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

  it('omits kind when saveDocument is called without one — the row records none', async () => {
    // saveDocument stores NULL for an omitted kind (it does not invent
    // 'spatial'), and the listing now reports that absence rather than
    // guessing. Clients that must render something (the gallery badge, the
    // daemon page's editor choice) already default locally, so the rendered
    // result is unchanged — only the claim in the data is gone.
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const list = await listDocuments('session1')
    expect(list.find((c) => c.path === 'canvas-a')?.kind).toBeUndefined()
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

  it('reports an unrecorded kind as unknown rather than guessing spatial', async () => {
    // Its only callers stamp the answer onto a restored canvas's row, so a
    // guess here is not a display default — it is written down, and a
    // markdown document that predates kinds becomes permanently spatial,
    // opened by the wrong editor. Both callers already omit a null kind,
    // which copies the source's real state, unknown included.
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    expect(await getDocumentKind('session1', 'canvas-a')).toBeNull()
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

  it('treats invalid snapshots as corruption instead of falling back to empty state', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDocumentIdByPath } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')
    const doc = new LoroDoc()
    const store = new FileVersionStore()
    await saveDocument('session1', 'broken', doc)
    await store.save('session1', 'broken', doc, { auto: true })
    const db = await getDb(tempDir)
    const documentId = await getDocumentIdByPath(db, 'session1', 'broken')
    // Corrupt the Libsql snapshot rows directly — compactDocument's
    // beforeBytes read succeeds (the header is intact), but its internal
    // loadDocument() call decodes the garbage chunk bytes and must surface
    // corruption rather than a silently-empty compaction.
    const libsqlStore = new LibsqlDocumentStore(db)
    const { manifest, chunks } = chunkSnapshot(Buffer.from('not-a-loro-snapshot'), 1_000_000)
    await libsqlStore.saveSnapshot({
      docRef: { kind: 'document', documentId: documentId! },
      manifest,
      chunks,
      frontier: new Uint8Array(),
    })

    await expect(compactDocument('session1', 'broken', store)).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      message: expect.stringContaining(`${documentId}.loro`),
    })
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
    // shallow snapshot must still match the doc's current oplog version.
    const { getDb } = await import('./db/index.js')
    const { getDocumentIdByPath } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const db = await getDb(tempDir)
    const documentId = await getDocumentIdByPath(db, 'session1', 'test')
    const libsqlStore = new LibsqlDocumentStore(db)
    const frontierResult = await libsqlStore.readFrontier({
      docRef: { kind: 'document', documentId: documentId! },
    })
    expect(frontierResult?.frontier).toEqual(live.oplogVersion().encode())
  })

  it('writes lastCompactedAt only on successful compaction', async () => {
    const { LoroMap } = await import('loro-crdt')
    const { getDb } = await import('./db/index.js')

    async function readLastCompactedAt(path: string): Promise<number | null> {
      const db = await getDb(tempDir)
      const row = await db
        .selectFrom('documents')
        .select(['lastCompactedAt'])
        .where('workspaceId', '=', 'session1')
        .where('path', '=', path)
        .executeTakeFirst()
      return row?.lastCompactedAt ?? null
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
  })

  // compactDocument's beforeBytes read and its internal doc reload both ran
  // unlocked before this test's fix, with only the final shallow-snapshot
  // write taking withDocumentWriteLock. A concurrent canvas-doc write (an
  // MCP tool call, or a WS/HTTP save) landing in that unlocked window was
  // captured by neither read, so compactDocument's later write silently
  // discarded it — the same lost-update class saveDocument's own write
  // already guards against, now reachable against compaction too because
  // both paths write the same Libsql rows.
  it('does not lose a concurrent canvas-doc write racing into the window between compactDocument reading the doc and writing its shallow snapshot', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { getDocumentIdByPath } = await import('./db/upsert-workspace.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot, reassembleSnapshot } = await import('@kamiazya/whiteboard-ports')
    const { withDocumentWriteLock } = await import('./workspace-lock.js')

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
    const documentId = (await getDocumentIdByPath(db, 'session1', 'test'))!

    // Delay only compactDocument's SECOND loadSnapshot call for this
    // document (its internal doc reload, after the beforeBytes read) —
    // AFTER it has already captured the pre-race bytes, so the delay opens
    // a real wall-clock window without changing what compactDocument reads.
    const originalLoadSnapshot = LibsqlDocumentStore.prototype.loadSnapshot
    let loadCallsForDoc = 0
    LibsqlDocumentStore.prototype.loadSnapshot = async function (
      this: InstanceType<typeof LibsqlDocumentStore>,
      input,
    ) {
      const forThisDoc = input.docRef.kind === 'document' && input.docRef.documentId === documentId
      const result = await originalLoadSnapshot.call(this, input)
      if (forThisDoc) {
        loadCallsForDoc++
        if (loadCallsForDoc === 2) {
          await new Promise((r) => setTimeout(r, 60))
        }
      }
      return result
    }

    try {
      const compactPromise = compactDocument('session1', 'test', store)

      // Give compactDocument a head start so it is mid-delay inside its
      // second (doc-reload) read before this fires from a genuinely
      // separate call chain (not nested inside compactDocument's own).
      await new Promise((r) => setTimeout(r, 20))
      const concurrentWrite = withDocumentWriteLock(documentId, async () => {
        const libsqlStore = new LibsqlDocumentStore(db)
        const existing = await libsqlStore.loadSnapshot({
          docRef: { kind: 'document', documentId },
        })
        const base = new LoroDoc()
        base.import(reassembleSnapshot(existing!.manifest, existing!.chunks))
        base.getMap('root').set('agentMarker', 'concurrent-edit')
        base.commit()
        const chunked = chunkSnapshot(base.export({ mode: 'snapshot' }), 1_000_000)
        await libsqlStore.saveSnapshot({
          docRef: { kind: 'document', documentId },
          manifest: chunked.manifest,
          chunks: chunked.chunks,
          frontier: base.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
        })
      })

      await Promise.all([compactPromise, concurrentWrite])
    } finally {
      LibsqlDocumentStore.prototype.loadSnapshot = originalLoadSnapshot
    }

    const after = await loadDocument('session1', 'test')
    expect(after.getMap('root').get('agentMarker')).toBe('concurrent-edit')
  })
})

describe('deleteDocument', () => {
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

  it('removes the documents row, cascades branches/versions rows, deletes the Libsql snapshot rows, and unlinks the version thumbnail PNGs, leaving the workspace row and a sibling canvas untouched', async () => {
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
    const documentRow = await db
      .selectFrom('documents')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'canvas-a')
      .executeTakeFirstOrThrow()
    const documentId = documentRow.id
    const docRef = { kind: 'document' as const, documentId }
    const libsqlStore = new LibsqlDocumentStore(db)

    const thumbPath = join(tempDir, 'blobs', 'session1', 'versions', `${version.id}.png`)
    await expect(libsqlStore.loadSnapshot({ docRef })).resolves.not.toBeNull()
    await expect(stat(thumbPath)).resolves.toBeDefined()

    await expect(deleteDocument('session1', 'canvas-a')).resolves.toBe(true)

    const canvasAfter = await db
      .selectFrom('documents')
      .selectAll()
      .where('id', '=', documentId)
      .executeTakeFirst()
    expect(canvasAfter).toBeUndefined()
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

    await expect(libsqlStore.loadSnapshot({ docRef })).resolves.toBeNull()
    await expect(libsqlStore.readFrontier({ docRef })).resolves.toBeNull()
    await expect(stat(thumbPath)).rejects.toThrow()

    const wsRow = await db
      .selectFrom('workspaces')
      .select(['id'])
      .where('id', '=', 'session1')
      .executeTakeFirst()
    expect(wsRow).toBeDefined()
    const siblingRow = await db
      .selectFrom('documents')
      .select(['path'])
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'canvas-b')
      .executeTakeFirst()
    expect(siblingRow).toBeDefined()
  })

  it('removes the .pre-migrate-bak file the legacy migration leaves beside the blob', async () => {
    const { getDb } = await import('./db/index.js')
    const { mkdir, stat, writeFile } = await import('node:fs/promises')

    await saveDocument('session1', 'migrated', new LoroDoc())
    const db = await getDb(tempDir)
    const row = await db
      .selectFrom('documents')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'migrated')
      .executeTakeFirstOrThrow()
    const bakPath = join(tempDir, 'blobs', 'session1', 'canvas', `${row.id}.loro.pre-migrate-bak`)
    // saveDocument no longer creates the blob directory (no FS blob is
    // written on the happy path), so the bak file's parent has to be made
    // explicitly here.
    await mkdir(dirname(bakPath), { recursive: true })
    await writeFile(bakPath, new Uint8Array([9, 9, 9]))

    await expect(deleteDocument('session1', 'migrated')).resolves.toBe(true)
    await expect(stat(bakPath)).rejects.toThrow()
  })

  it('returns false for a missing canvas without throwing; deleting the same canvas twice returns true then false', async () => {
    await expect(deleteDocument('session1', 'ghost')).resolves.toBe(false)

    await saveDocument('session1', 'once', new LoroDoc())
    await expect(deleteDocument('session1', 'once')).resolves.toBe(true)
    await expect(deleteDocument('session1', 'once')).resolves.toBe(false)
  })

  it('deletes a canvas whose FS blob was never written (unlinkIfExists ignores ENOENT so Libsql-only documents still delete)', async () => {
    const { getDb } = await import('./db/index.js')

    // saveDocument no longer writes an FS blob at all — this is the normal
    // case post-flip, not a simulated failure, but deleteDocument's
    // unconditional unlinkIfExists(blobPath) call must still no-op cleanly.
    await saveDocument('session1', 'row-only', new LoroDoc())
    const db = await getDb(tempDir)
    const row = await db
      .selectFrom('documents')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'row-only')
      .executeTakeFirstOrThrow()

    await expect(deleteDocument('session1', 'row-only')).resolves.toBe(true)
    const after = await db
      .selectFrom('documents')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirst()
    expect(after).toBeUndefined()
  })

  it('deletes cleanly a document whose FS blob was already removed by sweepImportedFsBlobs', async () => {
    const { generateDocumentId } = await import('@kamiazya/whiteboard-model')
    const { importFsBlobs } = await import('./db/migrations/0011-import-fs-blobs.js')
    const { DOCUMENT_DOC_KEY_PREFIX } = await import('./doc-ref-key.js')
    const { sweepImportedFsBlobs } = await import('./db/sweep-imported-fs-blobs.js')
    const { mkdir, writeFile, access } = await import('node:fs/promises')
    const { getDb } = await import('./db/index.js')
    const { upsertWorkspaceRow } = await import('./db/upsert-workspace.js')

    const db = await getDb(tempDir)
    await upsertWorkspaceRow(db, 'session1')
    const documentId = generateDocumentId()
    const now = Date.now()
    await db
      .insertInto('documents')
      .values({
        id: documentId,
        workspaceId: 'session1',
        path: 'swept-then-deleted',
        displayName: null,
        isPinned: 0,
        pinOrder: null,
        currentBranch: 'main',
        createdAt: now,
        updatedAt: now,
        kind: null,
      })
      .execute()

    const blobDoc = new LoroDoc()
    blobDoc.getText('content').insert(0, 'legacy FS blob, later imported and swept')
    blobDoc.commit()
    const blobDir = join(tempDir, 'blobs', 'session1', 'canvas')
    await mkdir(blobDir, { recursive: true })
    const blobPath = join(blobDir, `${documentId}.loro`)
    await writeFile(blobPath, blobDoc.export({ mode: 'snapshot' }))

    await importFsBlobs(
      db as unknown as Parameters<typeof importFsBlobs>[0],
      tempDir,
      DOCUMENT_DOC_KEY_PREFIX,
    )
    await sweepImportedFsBlobs(db, tempDir)
    await expect(access(blobPath)).rejects.toThrow() // pins the sweep precondition itself

    await expect(deleteDocument('session1', 'swept-then-deleted')).resolves.toBe(true)

    const after = await db
      .selectFrom('documents')
      .selectAll()
      .where('id', '=', documentId)
      .executeTakeFirst()
    expect(after).toBeUndefined()
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const libsqlStore = new LibsqlDocumentStore(db)
    await expect(
      libsqlStore.loadSnapshot({ docRef: { kind: 'document', documentId } }),
    ).resolves.toBeNull()
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
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { reassembleSnapshot } = await import('@kamiazya/whiteboard-ports')

    const doc = new LoroDoc()
    await saveDocument('session1', 'a', doc)
    await createBranch('session1', 'a', { name: 'feature' })
    const store = new FileVersionStore()
    const version = await store.save('session1', 'a', doc, { auto: true })

    const db = await getDb(tempDir)
    const before = await db
      .selectFrom('documents')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'a')
      .executeTakeFirstOrThrow()
    const documentId = before.id
    const libsqlStore = new LibsqlDocumentStore(db)
    const docRef = { kind: 'document' as const, documentId }
    const snapshotBefore = await libsqlStore.loadSnapshot({ docRef })
    if (snapshotBefore === null) throw new Error('expected a snapshot')
    const blobBefore = reassembleSnapshot(snapshotBefore.manifest, snapshotBefore.chunks)

    await expect(renameDocumentPath('session1', 'a', 'b')).resolves.toEqual({ documentId })

    const list = await listDocuments('session1')
    expect(list.map((c) => c.path)).toEqual(['b'])

    const after = await db
      .selectFrom('documents')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'b')
      .executeTakeFirstOrThrow()
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

    const snapshotAfter = await libsqlStore.loadSnapshot({ docRef })
    if (snapshotAfter === null) throw new Error('expected a snapshot')
    const blobAfter = reassembleSnapshot(snapshotAfter.manifest, snapshotAfter.chunks)
    expect(blobAfter).toEqual(blobBefore)

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
    const db = await getDb(tempDir)
    const before = await db
      .selectFrom('documents')
      .select(['id'])
      .where('workspaceId', '=', 'session1')
      .where('path', '=', 'a')
      .executeTakeFirstOrThrow()

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
    setAutoCompactTrigger(null)
    await disposeAutoCompact()
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saveDocument invokes the registered auto-compact trigger', async () => {
    const trigger = vi.fn<(workspaceId: string, path: string) => void>()
    setAutoCompactTrigger(trigger)
    await saveDocument('session1', 'foo', new LoroDoc())
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith('session1', 'foo')
  })

  it('scheduleAutoCompact debounces rapid triggers into a single compaction', async () => {
    const { LoroMap } = await import('loro-crdt')
    const { getDb } = await import('./db/index.js')

    async function readLastCompactedAt(): Promise<number | null> {
      const db = await getDb(tempDir)
      const row = await db
        .selectFrom('documents')
        .select(['lastCompactedAt'])
        .where('workspaceId', '=', 'session1')
        .where('path', '=', 'big')
        .executeTakeFirst()
      return row?.lastCompactedAt ?? null
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

  it('evicts the doc-cache after a successful auto-compact so the next save does not clobber the compacted file', async () => {
    // The trap: scheduleAutoCompact rewrites the on-disk blob with a
    // shallow snapshot, but a still-cached full LoroDoc would re-export
    // the entire history on the next save and silently undo the
    // optimisation. Confirm the cache is dropped so getDoc reloads from
    // the compacted file.
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

    // Pull through getDoc so the cache holds a live LoroDoc — this is what
    // happens on every WebSocket-backed canvas in production.
    await getDoc('session1', 'cached')
    expect(peekDoc('session1', 'cached')).toBeDefined()

    scheduleAutoCompact('session1', 'cached', store, { debounceMs: 50 })

    // Poll instead of a fixed sleep so this does not flake on a slow CI
    // runner. The whole point of this test: after the scheduled compaction
    // lands, the cache must be empty for that key so the next save reloads
    // the compacted file as its base.
    await vi.waitFor(
      () => {
        expect(peekDoc('session1', 'cached')).toBeUndefined()
      },
      { timeout: 2000 },
    )
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
    setAutoCompactTrigger(null)
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
  // just the earliestFrontiers lookup — the first await compactDocument makes
  // — so tests can deterministically observe the in-flight window instead of
  // depending on real-clock luck.
  function withDelayedEarliestFrontiers(
    store: InstanceType<typeof FileVersionStore>,
    delayMs: number,
  ): InstanceType<typeof FileVersionStore> {
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestFrontiers') {
          return async (workspaceId: string, path: string) => {
            await new Promise((r) => setTimeout(r, delayMs))
            return target.earliestFrontiers(workspaceId, path)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }

  it('cancels the pending debounce when the DB is disposed before it fires, instead of touching the destroyed driver', async () => {
    const store = await buildCompactableCanvas('big')
    const logs = captureLogsForTests('warning')

    // Do NOT call setAutoCompactTrigger(null) here — the point of this test
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
    const { getDb } = await import('./db/index.js')

    async function readLastCompactedAt(): Promise<number | null> {
      const db = await getDb(tempDir)
      const row = await db
        .selectFrom('documents')
        .select(['lastCompactedAt'])
        .where('workspaceId', '=', 'session1')
        .where('path', '=', 'cached')
        .executeTakeFirst()
      return row?.lastCompactedAt ?? null
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
        if (prop === 'earliestFrontiers') {
          return async (workspaceId: string, path: string) => {
            rescheduleCallCount.count += 1
            return target.earliestFrontiers(workspaceId, path)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const reentrantStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestFrontiers') {
          return async (workspaceId: string, path: string) => {
            await rescheduleGate
            scheduleAutoCompact('session1', 'reentrant', countingStore, { debounceMs: 0 })
            return target.earliestFrontiers(workspaceId, path)
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
        if (prop === 'earliestFrontiers') {
          return async (workspaceId: string, path: string) => {
            await new Promise((r) => setTimeout(r, 100))
            // Mirrors a compaction resuming and touching the DB again
            // (e.g. via loadDocument()) while teardown is draining hooks.
            reentrantDb = await getDb(tempDir)
            return target.earliestFrontiers(workspaceId, path)
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
    const { getDb } = await import('./db/index.js')

    async function readLastCompactedAt(): Promise<number | null> {
      const db = await getDb(tempDir)
      const row = await db
        .selectFrom('documents')
        .select(['lastCompactedAt'])
        .where('workspaceId', '=', 'session1')
        .where('path', '=', 'again')
        .executeTakeFirst()
      return row?.lastCompactedAt ?? null
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

  it('composes with setAutoCompactTrigger(null) in either order without dropping in-flight work', async () => {
    const store = await buildCompactableCanvas('composed')
    const { getDb } = await import('./db/index.js')

    async function readLastCompactedAt(): Promise<number | null> {
      const db = await getDb(tempDir)
      const row = await db
        .selectFrom('documents')
        .select(['lastCompactedAt'])
        .where('workspaceId', '=', 'session1')
        .where('path', '=', 'composed')
        .executeTakeFirst()
      return row?.lastCompactedAt ?? null
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

    // setAutoCompactTrigger(null) stays synchronous and timer-only: it must
    // not swallow the in-flight compaction that is already running.
    setAutoCompactTrigger(null)
    await disposeAutoCompact()

    expect(await readLastCompactedAt()).not.toBeNull()
  })
})
