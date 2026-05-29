import { describe, expect, it, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { MemoryStore, IndexedDBStore } from './browser-local-store.js'
import type { CanvasSnapshot } from './whiteboard-client.js'

const snap: CanvasSnapshot = {
  id: 'c1',
  name: 'untitled',
  scene: { elements: [] },
  updatedAt: '2026-05-24T00:00:00.000Z',
}

describe('MemoryStore', () => {
  it('load returns not-found for unknown id', async () => {
    const store = new MemoryStore()
    expect(await store.load('c1')).toEqual({ kind: 'not-found' })
  })

  it('save then load returns ok with snapshot', async () => {
    const store = new MemoryStore()
    await store.save(snap)
    expect(await store.load('c1')).toEqual({ kind: 'ok', snapshot: snap })
  })

  it('getDefaultCanvasId returns null initially', async () => {
    const store = new MemoryStore()
    expect(await store.getDefaultCanvasId()).toBeNull()
  })

  it('setDefaultCanvasId then get returns the set id', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    expect(await store.getDefaultCanvasId()).toBe('c1')
  })

  it('del with matching id deletes canvas and clears pointer', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    expect(await store.del('c1')).toEqual({ deleted: true })
    expect(await store.load('c1')).toEqual({ kind: 'not-found' })
    expect(await store.getDefaultCanvasId()).toBeNull()
  })

  it('del with pointer-mismatch returns not-deleted', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c2')
    await store.save(snap)
    expect(await store.del('c1')).toEqual({ deleted: false, reason: 'pointer-mismatch' })
  })

  it('del when no default id returns not-found', async () => {
    const store = new MemoryStore()
    expect(await store.del('c1')).toEqual({ deleted: false, reason: 'not-found' })
  })

  it('generateId returns a non-empty string each call', () => {
    const store = new MemoryStore()
    const a = store.generateId()
    const b = store.generateId()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })
})

describe('IndexedDBStore', () => {
  beforeEach(() => {
    // Fresh IDB factory per test for isolation
    globalThis.indexedDB = new IDBFactory()
  })

  it('getDefaultCanvasId returns null initially', async () => {
    const store = new IndexedDBStore()
    expect(await store.getDefaultCanvasId()).toBeNull()
  })

  it('setDefaultCanvasId then get returns the set id', async () => {
    const store = new IndexedDBStore()
    await store.setDefaultCanvasId('c1')
    expect(await store.getDefaultCanvasId()).toBe('c1')
  })

  it('load returns not-found for unknown id', async () => {
    const store = new IndexedDBStore()
    expect(await store.load('c1')).toEqual({ kind: 'not-found' })
  })

  it('save then load returns ok with snapshot', async () => {
    const store = new IndexedDBStore()
    await store.save(snap)
    expect(await store.load('c1')).toEqual({ kind: 'ok', snapshot: snap })
  })

  it('load returns corrupted for malformed stored data', async () => {
    // Write garbage directly via raw IDB
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('whiteboard', 1)
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        db.createObjectStore('meta')
        db.createObjectStore('canvases')
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('canvases', 'readwrite')
        tx.objectStore('canvases').put({ broken: true }, 'c1')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
    const store = new IndexedDBStore()
    expect(await store.load('c1')).toEqual({ kind: 'corrupted' })
  })

  it('del with matching id deletes canvas and clears pointer', async () => {
    const store = new IndexedDBStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    expect(await store.del('c1')).toEqual({ deleted: true })
    expect(await store.load('c1')).toEqual({ kind: 'not-found' })
    expect(await store.getDefaultCanvasId()).toBeNull()
  })

  it('del with pointer-mismatch returns not-deleted', async () => {
    const store = new IndexedDBStore()
    await store.setDefaultCanvasId('c2')
    await store.save(snap)
    expect(await store.del('c1')).toEqual({ deleted: false, reason: 'pointer-mismatch' })
  })

  it('del when no default id returns not-found', async () => {
    const store = new IndexedDBStore()
    expect(await store.del('c1')).toEqual({ deleted: false, reason: 'not-found' })
  })
})
