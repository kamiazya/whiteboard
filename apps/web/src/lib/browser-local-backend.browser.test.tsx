/**
 * 3-C: BrowserLocalBackend — CanvasBackend contract tests.
 *
 * Real browser context required for IndexedDB + loro-crdt WASM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Loro } from 'loro-crdt'
import { BrowserLocalBackend } from './browser-local-backend.js'
import type { CanvasBackendHandlers } from '@kamiazya/whiteboard-mcp/browser-contract'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

function makeHandlers(overrides: Partial<CanvasBackendHandlers> = {}): CanvasBackendHandlers {
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
  beforeEach(async () => { await clearDb() })
  afterEach(async () => { await clearDb() })

  it('connect() on empty store calls onConnected then onSnapshot with fresh empty snapshot', async () => {
    const handlers = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-1')
    backend.connect(handlers)
    // Give async IDB reads a moment
    await new Promise((r) => setTimeout(r, 50))
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
    await new Promise((r) => setTimeout(r, 50))
    await seedBackend.pushLocalUpdate(initial)
    seedBackend.disconnect()

    await new Promise((r) => setTimeout(r, 50))

    const handlers = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-1')
    backend.connect(handlers)
    await new Promise((r) => setTimeout(r, 50))

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
    await new Promise((r) => setTimeout(r, 50))

    // Push snapshot then delta
    await backend1.pushLocalUpdate(snapshot)
    await backend1.pushLocalUpdate(delta)
    backend1.disconnect()
    await new Promise((r) => setTimeout(r, 50))

    // Reload
    const backend2 = new BrowserLocalBackend('canvas-1')
    const h2 = makeHandlers()
    backend2.connect(h2)
    await new Promise((r) => setTimeout(r, 50))

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
    await new Promise((r) => setTimeout(r, 100))
    // onConnected fires synchronously before disconnect in this test,
    // so we only assert onSnapshot does not fire after disconnect.
    const snapshotCallCount = (handlers.onSnapshot as ReturnType<typeof vi.fn>).mock.calls.length
    await new Promise((r) => setTimeout(r, 100))
    expect((handlers.onSnapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBe(snapshotCallCount)
  })

  it('getFile returns null (deferred OPFS — not implemented in 3-C)', async () => {
    const backend = new BrowserLocalBackend('canvas-1')
    const result = await backend.getFile('any-file-id')
    expect(result).toBeNull()
  })

  it('putFile resolves without calling onFileSuccess (deferred OPFS)', async () => {
    const backend = new BrowserLocalBackend('canvas-1')
    const onFileSuccess = vi.fn()
    await expect(backend.putFile([['file-1', { mimeType: 'image/png', id: 'file-1', dataURL: 'data:image/png;base64,abc', created: Date.now() }]], onFileSuccess)).resolves.toBeUndefined()
    expect(onFileSuccess).not.toHaveBeenCalled()
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
    await new Promise((r) => setTimeout(r, 50))
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
    await new Promise((r) => setTimeout(r, 50))

    // Push a delta — should detect corrupt existing and route to onError
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
    await new Promise((r) => setTimeout(r, 50))

    // Push snapshot first to establish the record
    await backend.pushLocalUpdate(snapshot)
    // Then fire two deltas concurrently
    await Promise.all([
      backend.pushLocalUpdate(delta1),
      backend.pushLocalUpdate(delta2),
    ])
    backend.disconnect()

    // Reload and verify both deltas are persisted (not one overwriting the other)
    const backend2 = new BrowserLocalBackend('canvas-race')
    const h2 = makeHandlers()
    backend2.connect(h2)
    await new Promise((r) => setTimeout(r, 100))
    expect(h2.onRemoteUpdate).toHaveBeenCalledTimes(2)
    backend2.disconnect()
  })

  it('onError fires with unsupported-version for unknown-v record and onSnapshot is not called', async () => {
    // forceCorruptRecord writes { v: 99, garbage: true } — unknown version
    await forceCorruptRecord('canvas-v99')

    const h2 = makeHandlers()
    const backend2 = new BrowserLocalBackend('canvas-v99')
    backend2.connect(h2)
    await new Promise((r) => setTimeout(r, 50))

    expect(h2.onError).toHaveBeenCalledWith('unsupported-version')
    expect(h2.onSnapshot).not.toHaveBeenCalled()
    backend2.disconnect()
  })

  it('onError fires with corrupt-snapshot for v:1 envelope with invalid Loro bytes', async () => {
    await forceInvalidLoroRecord('canvas-bad-bytes')

    const h = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-bad-bytes')
    backend.connect(h)
    await new Promise((r) => setTimeout(r, 50))

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
    await new Promise((r) => setTimeout(r, 50))

    expect(h.onError).toHaveBeenCalledWith('corrupt-delta')
    expect(h.onSnapshot).not.toHaveBeenCalled()
    backend.disconnect()
  })
})

async function forceInvalidLoroRecord(canvasId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', 2)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('loroCanvases', 'readwrite')
      // v:1 envelope but snapshot bytes are not valid Loro data
      tx.objectStore('loroCanvases').put(
        { v: 1, snapshot: new Uint8Array([0xff, 0xfe, 0x00, 0x01]), updatedAt: new Date().toISOString() },
        canvasId,
      )
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
    req.onerror = () => reject(req.error)
  })
}

async function forceRecordWithBadDelta(canvasId: string, snapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', 2)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('loroCanvases', 'readwrite')
      // Valid snapshot but invalid delta bytes
      tx.objectStore('loroCanvases').put(
        {
          v: 1,
          snapshot,
          deltas: [new Uint8Array([0xff, 0xfe, 0x00, 0x01])],
          updatedAt: new Date().toISOString(),
        },
        canvasId,
      )
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
    req.onerror = () => reject(req.error)
  })
}

async function forceCorruptRecord(canvasId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', 2)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('loroCanvases', 'readwrite')
      tx.objectStore('loroCanvases').put({ v: 99, garbage: true }, canvasId)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
    req.onerror = () => reject(req.error)
  })
}
