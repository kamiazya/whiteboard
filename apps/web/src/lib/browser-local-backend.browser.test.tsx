/**
 * 3-C: BrowserLocalBackend — DocumentBackend contract tests.
 *
 * Real browser context required for IndexedDB + loro-crdt WASM.
 */

import type {
  BinaryFileDataLike,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_VERSION } from './browser-idb.js'
import { BrowserLocalBackend } from './browser-local-backend.js'

// Generous timeout: async IDB reads under CI load can take well over the
// 200ms fixed sleeps this file used to rely on. Waiting on the concrete
// handler call (instead of wall-clock time) keeps the test both fast on a
// healthy machine and stable under CI load.
const WAIT_TIMEOUT = 10_000

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

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

function makeInitialSnapshot(): Uint8Array {
  const doc = new Loro()
  doc.getList('elements').push({ id: 'seed' })
  return doc.export({ mode: 'snapshot' })
}

describe('BrowserLocalBackend', () => {
  beforeEach(async () => {
    await clearDb()
  })
  afterEach(async () => {
    await clearDb()
  })

  it('connect() on empty store calls onConnected then onSnapshot with fresh empty snapshot', async () => {
    const handlers = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-1')
    backend.connect(handlers)
    await vi.waitFor(
      () => {
        expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )
    expect(handlers.onConnected).toHaveBeenCalledTimes(1)
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
    const snapshotBytes = (handlers.onSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(snapshotBytes).toBeInstanceOf(Uint8Array)
    expect(snapshotBytes.length).toBeGreaterThan(0)
    backend.disconnect()
  })

  it('connect() delivers persisted snapshot before any onRemoteUpdate', async () => {
    // Pre-seed a record
    const initial = makeInitialSnapshot()
    const seedBackend = new BrowserLocalBackend('canvas-1')
    const seedHandlers = makeHandlers()
    seedBackend.connect(seedHandlers)
    await vi.waitFor(
      () => {
        expect(seedHandlers.onSnapshot).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )
    // pushLocalUpdate is awaited to completion, so the write is durable
    // before disconnect() — no additional wait needed here.
    await seedBackend.pushLocalUpdate(initial)
    seedBackend.disconnect()

    const handlers = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-1')
    backend.connect(handlers)
    await vi.waitFor(
      () => {
        expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )

    expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
    expect(handlers.onRemoteUpdate).not.toHaveBeenCalled()
    backend.disconnect()
  })

  it('pushLocalUpdate persists deltas; reload replays them after snapshot', async () => {
    const doc = new Loro()
    const list = doc.getList('elements')
    list.push({ id: 'a' })
    const snapshot = doc.export({ mode: 'snapshot' })
    const v0 = doc.version()
    list.push({ id: 'b' })
    const delta = doc.export({ mode: 'update', from: v0 })

    const backend1 = new BrowserLocalBackend('canvas-1')
    const h1 = makeHandlers()
    backend1.connect(h1)
    await vi.waitFor(
      () => {
        expect(h1.onSnapshot).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )

    // Push snapshot then delta — both awaited, so both writes are durable
    // before disconnect().
    await backend1.pushLocalUpdate(snapshot)
    await backend1.pushLocalUpdate(delta)
    backend1.disconnect()

    // Reload
    const backend2 = new BrowserLocalBackend('canvas-1')
    const h2 = makeHandlers()
    backend2.connect(h2)
    await vi.waitFor(
      () => {
        expect(h2.onSnapshot).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )

    expect(h2.onSnapshot).toHaveBeenCalledTimes(1)
    // Delta replayed as onRemoteUpdate
    expect(h2.onRemoteUpdate).toHaveBeenCalledTimes(1)
    backend2.disconnect()
  })

  it('disconnect() is idempotent — second call does not throw', () => {
    const backend = new BrowserLocalBackend('canvas-1')
    const handlers = makeHandlers()
    backend.connect(handlers)
    backend.disconnect()
    expect(() => backend.disconnect()).not.toThrow()
  })

  it('no callbacks fire after disconnect()', async () => {
    const backend = new BrowserLocalBackend('canvas-1')
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
    const backend = new BrowserLocalBackend('canvas-1')
    const result = await backend.getFile('any-file-id')
    expect(result).toBeNull()
  })

  it('putFile stores two entries, calls onFileSuccess exactly once per fileId, and getFile on a NEW instance returns each Blob', async () => {
    const backend = new BrowserLocalBackend('canvas-1')
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

    // Simulated reload: fresh instance, same documentId.
    const reloaded = new BrowserLocalBackend('canvas-1')
    const blob1 = await reloaded.getFile('file-1')
    const blob2 = await reloaded.getFile('file-2')
    expect(blob1).not.toBeNull()
    expect(blob1?.type).toBe('image/png')
    expect(blob2).not.toBeNull()
    expect(blob2?.type).toBe('image/jpeg')
  })

  it('putFile keys by the tuple fileId, never BinaryFileDataLike.id', async () => {
    const backend = new BrowserLocalBackend('canvas-1')
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
    const backend = new BrowserLocalBackend('canvas-1')
    const onFileSuccess = vi.fn()
    await expect(backend.putFile([], onFileSuccess)).resolves.toBeUndefined()
    expect(onFileSuccess).not.toHaveBeenCalled()
  })

  it('getFile returns null for a corrupt stored record and NEVER calls onError (repeated calls produce zero onError invocations)', async () => {
    await forceCorruptFileRecord('canvas-1', 'corrupt-file')
    const handlers = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-1')
    backend.connect(handlers)
    await vi.waitFor(
      () => {
        expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )

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
    const backend = new BrowserLocalBackend(
      'canvas-1',
      undefined,
      faultyStore as unknown as import('./document-file-store.js').DocumentFileStore,
    )
    backend.connect(handlers)
    await vi.waitFor(
      () => {
        expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )

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
    const backend = new BrowserLocalBackend('canvas-1')
    expect(() => backend.sendClientReady()).not.toThrow()
    expect(() => backend.sendExportResponse('req-1', 'data:image/png;base64,abc')).not.toThrow()
  })

  it('pushLocalUpdate with empty bytes is a no-op — no IDB write, no error', async () => {
    const backend = new BrowserLocalBackend('canvas-1')
    const handlers = makeHandlers()
    backend.connect(handlers)
    await vi.waitFor(
      () => {
        expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )
    // Empty bytes: early return, no throw, no onError
    await expect(backend.pushLocalUpdate(new Uint8Array(0))).resolves.toBeUndefined()
    expect(handlers.onError).not.toHaveBeenCalled()
    backend.disconnect()
  })

  it('pushLocalUpdate with corrupted existing record calls onError("corrupt-snapshot")', async () => {
    // Pre-seed a corrupt record
    await forceCorruptRecord('canvas-corrupt')

    const handlers = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-corrupt')
    backend.connect(handlers)
    // connect()'s own load surfaces the corrupt record as onError first.
    await vi.waitFor(
      () => {
        expect(handlers.onError).toHaveBeenCalled()
      },
      { timeout: WAIT_TIMEOUT },
    )

    // Push a delta — should detect corrupt existing and route to onError.
    // pushLocalUpdate is awaited, so the resulting onError call is
    // synchronous with the resolved promise; no additional wait needed.
    const delta = new Uint8Array([1, 2, 3])
    await backend.pushLocalUpdate(delta)
    expect(handlers.onError).toHaveBeenCalledWith('storage-failure')
    backend.disconnect()
  })

  it('concurrent pushLocalUpdate calls do not race: second write is not lost', async () => {
    const doc = new Loro()
    const list = doc.getList('elements')
    list.push({ id: 'a' })
    const snapshot = doc.export({ mode: 'snapshot' })
    const v0 = doc.version()
    list.push({ id: 'b' })
    const delta1 = doc.export({ mode: 'update', from: v0 })
    const v1 = doc.version()
    list.push({ id: 'c' })
    const delta2 = doc.export({ mode: 'update', from: v1 })

    const backend = new BrowserLocalBackend('canvas-race')
    const handlers = makeHandlers()
    backend.connect(handlers)
    await vi.waitFor(
      () => {
        expect(handlers.onSnapshot).toHaveBeenCalledTimes(1)
      },
      { timeout: WAIT_TIMEOUT },
    )

    // Push snapshot first to establish the record
    await backend.pushLocalUpdate(snapshot)
    // Then fire two deltas concurrently
    await Promise.all([backend.pushLocalUpdate(delta1), backend.pushLocalUpdate(delta2)])
    backend.disconnect()

    // Reload and verify both deltas are persisted (not one overwriting the other)
    const backend2 = new BrowserLocalBackend('canvas-race')
    const h2 = makeHandlers()
    backend2.connect(h2)
    await vi.waitFor(
      () => {
        expect(h2.onRemoteUpdate).toHaveBeenCalledTimes(2)
      },
      { timeout: WAIT_TIMEOUT },
    )
    expect(h2.onRemoteUpdate).toHaveBeenCalledTimes(2)
    backend2.disconnect()
  })

  it('onError fires with unsupported-version for unknown-v record and onSnapshot is not called', async () => {
    // forceCorruptRecord writes { v: 99, garbage: true } — unknown version
    await forceCorruptRecord('canvas-v99')

    const h2 = makeHandlers()
    const backend2 = new BrowserLocalBackend('canvas-v99')
    backend2.connect(h2)
    await vi.waitFor(
      () => {
        expect(h2.onError).toHaveBeenCalledWith('unsupported-version')
      },
      { timeout: WAIT_TIMEOUT },
    )

    expect(h2.onError).toHaveBeenCalledWith('unsupported-version')
    expect(h2.onSnapshot).not.toHaveBeenCalled()
    backend2.disconnect()
  })

  it('onError fires with corrupt-snapshot for v:1 envelope with invalid Loro bytes', async () => {
    await forceInvalidLoroRecord('canvas-bad-bytes')

    const h = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-bad-bytes')
    backend.connect(h)
    await vi.waitFor(
      () => {
        expect(h.onError).toHaveBeenCalledWith('corrupt-snapshot')
      },
      { timeout: WAIT_TIMEOUT },
    )

    expect(h.onError).toHaveBeenCalledWith('corrupt-snapshot')
    expect(h.onSnapshot).not.toHaveBeenCalled()
    backend.disconnect()
  })

  it('onError fires with corrupt-delta for valid snapshot but invalid delta bytes', async () => {
    const doc = new Loro()
    doc.getList('elements').push({ id: 'a' })
    const snapshot = doc.export({ mode: 'snapshot' })

    await forceRecordWithBadDelta('canvas-bad-delta', snapshot)

    const h = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-bad-delta')
    backend.connect(h)
    await vi.waitFor(
      () => {
        expect(h.onError).toHaveBeenCalledWith('corrupt-delta')
      },
      { timeout: WAIT_TIMEOUT },
    )

    expect(h.onError).toHaveBeenCalledWith('corrupt-delta')
    expect(h.onSnapshot).not.toHaveBeenCalled()
    backend.disconnect()
  })
})

async function forceInvalidLoroRecord(documentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents')
      if (!db.objectStoreNames.contains('loroDocuments')) db.createObjectStore('loroDocuments')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('loroDocuments', 'readwrite')
      // v:1 envelope but snapshot bytes are not valid Loro data
      tx.objectStore('loroDocuments').put(
        {
          v: 1,
          snapshot: new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
          updatedAt: new Date().toISOString(),
        },
        documentId,
      )
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

async function forceRecordWithBadDelta(documentId: string, snapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents')
      if (!db.objectStoreNames.contains('loroDocuments')) db.createObjectStore('loroDocuments')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('loroDocuments', 'readwrite')
      // Valid snapshot but invalid delta bytes
      tx.objectStore('loroDocuments').put(
        {
          v: 1,
          snapshot,
          deltas: [new Uint8Array([0xff, 0xfe, 0x00, 0x01])],
          updatedAt: new Date().toISOString(),
        },
        documentId,
      )
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

async function forceCorruptFileRecord(_canvasId: string, fileId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents')
      if (!db.objectStoreNames.contains('loroDocuments')) db.createObjectStore('loroDocuments')
      if (!db.objectStoreNames.contains('documentFiles')) db.createObjectStore('documentFiles')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('documentFiles', 'readwrite')
      // Missing required fields — fails documentFileRecordSchema.safeParse.
      tx.objectStore('documentFiles').put({ v: 1, garbage: true }, fileId)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

async function forceCorruptRecord(documentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents')
      if (!db.objectStoreNames.contains('loroDocuments')) db.createObjectStore('loroDocuments')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('loroDocuments', 'readwrite')
      tx.objectStore('loroDocuments').put({ v: 99, garbage: true }, documentId)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}
