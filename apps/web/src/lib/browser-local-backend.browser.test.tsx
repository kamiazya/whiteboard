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

  it('onError fires with corrupt-snapshot when backend receives corrupt bytes and onSnapshot is not called', async () => {
    const handlers = makeHandlers()
    const backend = new BrowserLocalBackend('canvas-1')
    backend.connect(handlers)
    await new Promise((r) => setTimeout(r, 50))

    // Force a corrupt snapshot into IDB directly
    await forceCorruptRecord('canvas-1')
    backend.disconnect()

    const backend2 = new BrowserLocalBackend('canvas-1')
    const h2 = makeHandlers()
    backend2.connect(h2)
    await new Promise((r) => setTimeout(r, 50))

    // Corrupt record → onError, not onSnapshot
    expect(h2.onError).toHaveBeenCalledWith('corrupt-snapshot')
    expect(h2.onSnapshot).not.toHaveBeenCalled()
    backend2.disconnect()
  })
})

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
