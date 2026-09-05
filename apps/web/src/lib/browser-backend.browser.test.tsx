/**
 * 3-C: BrowserBackend — DocumentBackend contract tests, workspace-backed.
 *
 * Real browser context required for IndexedDB + loro-crdt WASM. The backend
 * delivers the WORKSPACE document (every document a tree node) and persists
 * pushed updates through the shared incremental save; these tests assert that
 * contract from the outside: what connect() delivers, where a push lands, and
 * how legacy per-document records (readable, unclassifiable, unreadable) are
 * treated on the way in.
 */

import type {
  BinaryFileDataLike,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
// Stays in REAL-browser mode on purpose: this file is part of the real-IDB
// fidelity contract (transaction/upgrade/abort semantics fake-indexeddb only
// approximates). IndexedDB-only suites with no such stake run in jsdom via
// fake-indexeddb instead — see e.g. local-document-summary.test.tsx.
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  projectWorkspaceDocument,
  readSpatialCanvas,
  resolveWorkspaceDocumentById,
  writeSpatialCanvas,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { Loro, LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { BrowserBackend, type BrowserBackendTarget } from './browser-backend.js'
import { BROWSER_DEFAULT_SEGMENT, openWhiteboardDb } from './browser-idb.js'

/** A canonical id no fixture mints, so a save under it can only be the bug. */
const ELSEWHERE_ULID = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ'

import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId, setBrowserWorkspaceIdForTests } from './browser-workspace-id.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('browser-backend')

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const ID_C = '01CX5ZZKBKACTAV9WEVGEMMVRZ'
const ID_D = '01DX5ZZKBKACTAV9WEVGEMMVRZ'
const ID_E = '01EX5ZZKBKACTAV9WEVGEMMVRZ'
const ID_F = '01FX5ZZKBKACTAV9WEVGEMMVRZ'

function target(documentId: string, path = 'design'): BrowserBackendTarget {
  return { documentId, path, kind: 'spatial' }
}

// Generous timeout: async IDB reads under CI load can take well over the
// 200ms fixed sleeps this file used to rely on. Waiting on the concrete
// handler call (instead of wall-clock time) keeps the test both fast on a
// healthy machine and stable under CI load.
const WAIT_TIMEOUT = 10_000

function makeHandlers(overrides: Partial<DocumentBackendHandlers> = {}): DocumentBackendHandlers {
  return {
    onSnapshot: vi.fn(),
    onRemoteUpdate: vi.fn(),
    onVersionCreated: vi.fn(),
    onRestoreStarted: vi.fn(),
    onRestoreComplete: vi.fn(),
    onHeadChanged: vi.fn(),
    onViewportRequest: vi.fn(),
    onExportRequest: vi.fn(),
    onConnected: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

function deliveredSnapshot(handlers: DocumentBackendHandlers): Uint8Array {
  return (handlers.onSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0] as Uint8Array
}

async function connectAndWait(
  backend: BrowserBackend,
  handlers: DocumentBackendHandlers,
): Promise<void> {
  backend.connect(handlers)
  await vi.waitFor(
    () => {
      expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
    },
    { timeout: WAIT_TIMEOUT },
  )
}

/**
 * The session's side of the contract, in miniature: import the delivered
 * workspace snapshot, commit an edit through the content scope, and hand back
 * the update bytes a real session would push.
 */
function editAsSession(snapshotBytes: Uint8Array, documentId: string, nodeId: string): Uint8Array {
  const doc = new LoroDoc()
  doc.import(snapshotBytes)
  const from = doc.version()
  writeSpatialNode(documentContainers(doc, documentId), {
    id: nodeId,
    type: 'text',
    x: 0,
    y: 0,
    width: 80,
    height: 40,
    text: nodeId,
  })
  return doc.export({ mode: 'update', from })
}

describe('BrowserBackend', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(async () => {
    await clearWhiteboardDb()
  })

  it('connect() on an empty store delivers a workspace snapshot already holding the target document', async () => {
    const handlers = makeHandlers()
    const backend = new BrowserBackend(target(ID_A))
    await connectAndWait(backend, handlers)

    expect(handlers.onConnected).toHaveBeenCalledTimes(1)
    const bytes = deliveredSnapshot(handlers)
    expect(bytes).toBeInstanceOf(Uint8Array)
    const doc = new LoroDoc()
    doc.import(bytes)
    // The target was placed in the tree before delivery, so the scoped
    // session can resolve its containers immediately.
    expect(resolveWorkspaceDocumentById(doc, ID_A)?.path).toBe('design')
    backend.disconnect()
  })

  it('a pushed edit lands on the document tree node and survives a reload', async () => {
    const handlers = makeHandlers()
    const backend = new BrowserBackend(target(ID_A))
    await connectAndWait(backend, handlers)

    await backend.pushLocalUpdate(editAsSession(deliveredSnapshot(handlers), ID_A, 'n-edit'))
    backend.disconnect()

    const h2 = makeHandlers()
    const backend2 = new BrowserBackend(target(ID_A))
    await connectAndWait(backend2, h2)

    const doc = new LoroDoc()
    doc.import(deliveredSnapshot(h2))
    const canvas = readSpatialCanvas(documentContainers(doc, ID_A))
    expect(canvas.nodes.map((n) => n.id)).toEqual(['n-edit'])
    // Deltas are merged into the snapshot on open — nothing replays.
    expect(h2.onRemoteUpdate).not.toHaveBeenCalled()
    backend2.disconnect()
  })

  it('a readable legacy per-document record is folded in and served from the tree', async () => {
    const legacy = new Loro()
    writeSpatialCanvas(legacy, {
      nodes: [{ id: 'n-old', type: 'text', x: 1, y: 2, width: 80, height: 40, text: 'kept' }],
      edges: [],
    })
    await seedSyncDocument(ID_B, { snapshot: legacy.export({ mode: 'snapshot' }) }, ISOLATED_DB)

    const handlers = makeHandlers()
    const backend = new BrowserBackend(target(ID_B, 'imported'))
    await connectAndWait(backend, handlers)

    const doc = new LoroDoc()
    doc.import(deliveredSnapshot(handlers))
    const projected = projectWorkspaceDocument(doc, ID_B)
    expect(projected).not.toBeNull()
    expect(projected === null ? [] : readSpatialCanvas(projected).nodes.map((n) => n.id)).toEqual([
      'n-old',
    ])
    backend.disconnect()
  })

  it('refuses to deliver when another document already owns the target path, without calling it corruption', async () => {
    // The tree already has a DIFFERENT document standing where this one
    // wants to be placed. `createWorkspaceDocumentAtPath` answers null for
    // that, and the backend used to ignore the answer: it saved and delivered
    // bytes holding no node for the target, and the session then reported
    // `corrupt-snapshot` — the screen whose one action deletes the record.
    // Nothing is corrupt. The bytes are intact and say exactly what is there.
    const workspaceId = getBrowserWorkspaceId()
    const docs = new BrowserWorkspaceDocs()
    const seeded = await docs.create(workspaceId)
    expect(
      createWorkspaceDocumentAtPath(seeded, { path: 'design', documentId: ID_B, kind: 'spatial' }),
    ).not.toBeNull()
    await docs.save(workspaceId, seeded)

    const handlers = makeHandlers()
    const backend = new BrowserBackend(target(ID_A, 'design'))
    backend.connect(handlers)
    await vi.waitFor(
      () => {
        expect(handlers.onError).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )

    // Non-destructive: a reason the page answers with "try again", never
    // with an offer to start fresh over the document that IS there.
    expect(handlers.onError).toHaveBeenCalledWith('read-unavailable')
    // And no snapshot — an editor over bytes that lack this document is how
    // the next save shadows the one at that path.
    expect(handlers.onSnapshot).not.toHaveBeenCalled()
    backend.disconnect()
  })

  it('disconnect() is idempotent — second call does not throw', () => {
    const backend = new BrowserBackend(target(ID_A))
    const handlers = makeHandlers()
    backend.connect(handlers)
    backend.disconnect()
    expect(() => backend.disconnect()).not.toThrow()
  })

  it('no callbacks fire after disconnect()', async () => {
    const backend = new BrowserBackend(target(ID_A))
    const handlers = makeHandlers()
    backend.connect(handlers)
    backend.disconnect()
    // Absence assertion: vi.waitFor can only prove a callback DID fire, not
    // that it never will, so this is the one deliberately bounded drain
    // left in this file — long enough for the in-flight IDB read started
    // by connect() to settle before we assert it produced no callback.
    await new Promise((r) => setTimeout(r, 250))
    expect(handlers.onSnapshot).not.toHaveBeenCalled()
  })

  it('getFile returns null for an unknown fileId', async () => {
    const backend = new BrowserBackend(target(ID_A))
    const result = await backend.getFile('any-file-id')
    expect(result).toBeNull()
  })

  it('putFile stores two entries, calls onFileSuccess exactly once per fileId, and getFile on a NEW instance returns each Blob', async () => {
    const backend = new BrowserBackend(target(ID_A))
    const onFileSuccess = vi.fn()
    const entries: [string, BinaryFileDataLike][] = [
      [
        'file-1',
        {
          mimeType: 'image/png',
          id: 'file-1',
          dataURL: 'data:image/png;base64,QQ==',
          created: Date.now(),
        },
      ],
      [
        'file-2',
        {
          mimeType: 'image/jpeg',
          id: 'file-2',
          dataURL: 'data:image/jpeg;base64,QkI=',
          created: Date.now(),
        },
      ],
    ]

    await backend.putFile(entries, onFileSuccess)

    expect(onFileSuccess).toHaveBeenCalledTimes(2)
    expect(onFileSuccess).toHaveBeenCalledWith('file-1')
    expect(onFileSuccess).toHaveBeenCalledWith('file-2')

    // Simulated reload: fresh instance, same document.
    const reloaded = new BrowserBackend(target(ID_A))
    const blob1 = await reloaded.getFile('file-1')
    const blob2 = await reloaded.getFile('file-2')
    expect(blob1).not.toBeNull()
    expect(blob1?.type).toBe('image/png')
    expect(blob2).not.toBeNull()
    expect(blob2?.type).toBe('image/jpeg')
  })

  it('putFile keys by the tuple fileId, never BinaryFileDataLike.id', async () => {
    const backend = new BrowserBackend(target(ID_A))
    const onFileSuccess = vi.fn()
    const tupleKey = 'tuple-key'
    const disagreeingDataId = 'data-id-disagrees'

    await backend.putFile(
      [
        [
          tupleKey,
          {
            mimeType: 'image/png',
            id: disagreeingDataId,
            dataURL: 'data:image/png;base64,QQ==',
            created: Date.now(),
          },
        ],
      ],
      onFileSuccess,
    )

    expect(onFileSuccess).toHaveBeenCalledWith(tupleKey)
    expect(onFileSuccess).not.toHaveBeenCalledWith(disagreeingDataId)
    expect(await backend.getFile(tupleKey)).not.toBeNull()
    expect(await backend.getFile(disagreeingDataId)).toBeNull()
  })

  it('putFile with an empty newEntries array resolves immediately with no IDB writes and zero onFileSuccess calls', async () => {
    const backend = new BrowserBackend(target(ID_A))
    const onFileSuccess = vi.fn()
    await expect(backend.putFile([], onFileSuccess)).resolves.toBeUndefined()
    expect(onFileSuccess).not.toHaveBeenCalled()
  })

  it('getFile returns null for a corrupt stored record and NEVER calls onError (repeated calls produce zero onError invocations)', async () => {
    await forceCorruptFileRecord('corrupt-file')
    const handlers = makeHandlers()
    const backend = new BrowserBackend(target(ID_A))
    await connectAndWait(backend, handlers)

    expect(await backend.getFile('corrupt-file')).toBeNull()
    expect(await backend.getFile('corrupt-file')).toBeNull()
    expect(handlers.onError).not.toHaveBeenCalled()
    backend.disconnect()
  })

  it('putFile rejects and calls onError("storage-failure") without calling onFileSuccess when the underlying store put fails', async () => {
    const handlers = makeHandlers()
    const faultyStore = {
      put: vi.fn().mockRejectedValue(new Error('simulated IDB failure')),
      get: vi.fn().mockResolvedValue(null),
    }
    const backend = new BrowserBackend(
      target(ID_A),
      undefined,
      faultyStore as unknown as import('./document-file-store.js').DocumentFileStore,
    )
    await connectAndWait(backend, handlers)

    const onFileSuccess = vi.fn()
    await expect(
      backend.putFile(
        [
          [
            'file-1',
            {
              mimeType: 'image/png',
              id: 'file-1',
              dataURL: 'data:image/png;base64,QQ==',
              created: Date.now(),
            },
          ],
        ],
        onFileSuccess,
      ),
    ).rejects.toThrow()

    expect(onFileSuccess).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledWith('storage-failure')
    backend.disconnect()
  })

  it('sendClientReady and sendExportResponse are no-ops (no WebSocket)', () => {
    const backend = new BrowserBackend(target(ID_A))
    expect(() => backend.sendClientReady()).not.toThrow()
    expect(() => backend.sendExportResponse('req-1', 'data:image/png;base64,abc')).not.toThrow()
  })

  it('pushLocalUpdate with empty bytes is a no-op — no IDB write, no error', async () => {
    const backend = new BrowserBackend(target(ID_A))
    const handlers = makeHandlers()
    await connectAndWait(backend, handlers)
    // Empty bytes: early return, no throw, no onError
    await expect(backend.pushLocalUpdate(new Uint8Array(0))).resolves.toBeUndefined()
    expect(handlers.onError).not.toHaveBeenCalled()
    backend.disconnect()
  })

  it('concurrent pushLocalUpdate calls do not race: second write is not lost', async () => {
    const backend = new BrowserBackend(target(ID_C))
    const handlers = makeHandlers()
    await connectAndWait(backend, handlers)

    // Two edits from the same delivered lineage, pushed concurrently — the
    // way two quick session commits arrive.
    const base = deliveredSnapshot(handlers)
    const doc = new LoroDoc()
    doc.import(base)
    const v0 = doc.version()
    writeSpatialNode(documentContainers(doc, ID_C), {
      id: 'n-1',
      type: 'text',
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      text: 'one',
    })
    const delta1 = doc.export({ mode: 'update', from: v0 })
    const v1 = doc.version()
    writeSpatialNode(documentContainers(doc, ID_C), {
      id: 'n-2',
      type: 'text',
      x: 100,
      y: 0,
      width: 80,
      height: 40,
      text: 'two',
    })
    const delta2 = doc.export({ mode: 'update', from: v1 })

    await Promise.all([backend.pushLocalUpdate(delta1), backend.pushLocalUpdate(delta2)])
    backend.disconnect()

    const h2 = makeHandlers()
    const backend2 = new BrowserBackend(target(ID_C))
    await connectAndWait(backend2, h2)
    const reloaded = new LoroDoc()
    reloaded.import(deliveredSnapshot(h2))
    const ids = readSpatialCanvas(documentContainers(reloaded, ID_C))
      .nodes.map((n) => n.id)
      .sort()
    expect(ids).toEqual(['n-1', 'n-2'])
    backend2.disconnect()
  })

  it('a write still on the queue when disconnect() runs is not dropped', async () => {
    // flush-before-switch (ADR-0019). `disconnect()` nulled `workspaceDoc`
    // synchronously and `_doWrite` returned early on a null doc, so anything
    // still queued reached storage never. The code called that "a
    // disconnected straggler"; from the person's side it is the edit they
    // just made, gone — and a workspace switch unmounts the session at
    // exactly the moment one is in flight.
    const backend = new BrowserBackend(target(ID_C))
    const handlers = makeHandlers()
    await connectAndWait(backend, handlers)

    const doc = new LoroDoc()
    doc.import(deliveredSnapshot(handlers))
    const v0 = doc.version()
    writeSpatialNode(documentContainers(doc, ID_C), {
      id: 'n-late',
      type: 'text',
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      text: 'late',
    })
    const delta = doc.export({ mode: 'update', from: v0 })

    // Deliberately NOT awaited before disconnecting — that ordering is the
    // whole case.
    const pending = backend.pushLocalUpdate(delta)
    backend.disconnect()
    await pending

    const h2 = makeHandlers()
    const backend2 = new BrowserBackend(target(ID_C))
    await connectAndWait(backend2, h2)
    const reloaded = new LoroDoc()
    reloaded.import(deliveredSnapshot(h2))
    expect(readSpatialCanvas(documentContainers(reloaded, ID_C)).nodes.map((n) => n.id)).toContain(
      'n-late',
    )
    backend2.disconnect()
  })

  it('a queued write lands in the workspace it was made in, not the one switched to', async () => {
    // The sharper half, and the one a switcher makes reachable. `_doWrite`
    // read `getBrowserWorkspaceId()` at EXECUTION time, so re-pointing the
    // active workspace while a write was in flight filed that write under
    // the INCOMING workspace. Losing an edit is bad; writing it into someone
    // else's workspace is worse.
    // Subclassed rather than hand-stubbed: `WorkspaceDocs` has more members
    // than this case cares about, and a partial literal would only compile by
    // being cast — which is how a double stops standing for the real thing.
    class RecordingDocs extends BrowserWorkspaceDocs {
      readonly saves: string[] = []
      override save(workspaceId: string, doc: LoroDoc) {
        this.saves.push(workspaceId)
        return super.save(workspaceId, doc)
      }
    }
    const recording = new RecordingDocs()
    const origin = getBrowserWorkspaceId()
    const backend = new BrowserBackend(target(ID_C), recording)
    const handlers = makeHandlers()
    await connectAndWait(backend, handlers)

    const doc = new LoroDoc()
    doc.import(deliveredSnapshot(handlers))
    const v0 = doc.version()
    writeSpatialNode(documentContainers(doc, ID_C), {
      id: 'n-origin',
      type: 'text',
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      text: 'origin',
    })
    const delta = doc.export({ mode: 'update', from: v0 })

    const pending = backend.pushLocalUpdate(delta)
    // The switch, mid-flight.
    setBrowserWorkspaceIdForTests(ELSEWHERE_ULID, 'elsewhere')
    await pending
    setBrowserWorkspaceIdForTests(origin, BROWSER_DEFAULT_SEGMENT)

    // The invariant is not how MANY saves happen — connect writes too — but
    // that none of them files this session's bytes under the workspace the
    // address moved to.
    expect(recording.saves).not.toContain(ELSEWHERE_ULID)
    expect(recording.saves).toContain(origin)
    backend.disconnect()
  })

  it('an unreadable legacy record surfaces its own failure and is NOT shadowed by an empty node', async () => {
    // {v:99} — an envelope from a version this build does not know.
    await seedSyncDocument(ID_D, { raw: { v: 99, garbage: true } }, ISOLATED_DB)

    const h = makeHandlers()
    const backend = new BrowserBackend(target(ID_D, 'damaged'))
    backend.connect(h)
    await vi.waitFor(
      () => {
        expect(h.onError).toHaveBeenCalledWith('unsupported-version')
      },
      { timeout: WAIT_TIMEOUT },
    )
    expect(h.onSnapshot).not.toHaveBeenCalled()

    // A push against an undelivered document has nothing to land on and must
    // not throw — the session never got a doc to edit anyway.
    await expect(backend.pushLocalUpdate(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined()
    backend.disconnect()
  })

  it('onError fires with corrupt-snapshot for v:1 envelope with invalid Loro bytes', async () => {
    await seedSyncDocument(
      ID_E,
      { snapshot: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) },
      ISOLATED_DB,
    )

    const h = makeHandlers()
    const backend = new BrowserBackend(target(ID_E, 'damaged'))
    backend.connect(h)
    await vi.waitFor(
      () => {
        expect(h.onError).toHaveBeenCalledWith('corrupt-snapshot')
      },
      { timeout: WAIT_TIMEOUT },
    )
    expect(h.onSnapshot).not.toHaveBeenCalled()
    backend.disconnect()
  })

  it('onError fires with corrupt-delta for valid snapshot but invalid delta bytes', async () => {
    const doc = new Loro()
    doc.getList('elements').push({ id: 'a' })
    await seedSyncDocument(
      ID_F,
      {
        snapshot: doc.export({ mode: 'snapshot' }),
        deltas: [new Uint8Array([0xff, 0xfe, 0x00, 0x01])],
      },
      ISOLATED_DB,
    )

    const h = makeHandlers()
    const backend = new BrowserBackend(target(ID_F, 'damaged'))
    backend.connect(h)
    await vi.waitFor(
      () => {
        expect(h.onError).toHaveBeenCalledWith('corrupt-delta')
      },
      { timeout: WAIT_TIMEOUT },
    )
    expect(h.onSnapshot).not.toHaveBeenCalled()
    backend.disconnect()
  })
})

async function forceCorruptFileRecord(fileId: string): Promise<void> {
  // The REAL opener, not a hand-rolled schema — see the history on this
  // helper: a fixture database that drifts from the app's schema stops
  // exercising anything.
  const db = await openWhiteboardDb(ISOLATED_DB)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('documentFiles', 'readwrite')
      // Missing required fields — fails documentFileRecordSchema.safeParse.
      tx.objectStore('documentFiles').put({ v: 1, garbage: true }, fileId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
    })
  } finally {
    db.close()
  }
}
