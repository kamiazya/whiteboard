/**
 * CanvasFileStore — real IndexedDB round-trip tests.
 *
 * Real browser context required for IndexedDB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openWhiteboardDb } from './browser-idb.js'
import { CanvasFileStore, canvasFileRecordSchema } from './canvas-file-store.js'

// Rejects on failure: silently keeping stale fixed-key records would let
// these persistence tests pass without exercising the current write.
async function clearDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('whiteboard database deletion was blocked'))
  })
}

describe('CanvasFileStore', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('put then get round-trips a Blob with identical bytes and mimeType', async () => {
    const store = new CanvasFileStore()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const blob = new Blob([bytes], { type: 'image/png' })

    await store.put('file-1', { mimeType: 'image/png', blob, created: 123 })
    const result = await store.get('file-1')

    expect(result).not.toBeNull()
    expect(result?.type).toBe('image/png')
    const resultBytes = new Uint8Array(await (result as Blob).arrayBuffer())
    expect(Array.from(resultBytes)).toEqual(Array.from(bytes))
  })

  it('stored record carries v:1', async () => {
    const store = new CanvasFileStore()
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' })
    await store.put('file-1', { mimeType: 'image/png', blob, created: 123 })

    const db = await openWhiteboardDb()
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('canvasFiles', 'readonly')
      const req = tx.objectStore('canvasFiles').get('file-1')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
    const parsed = canvasFileRecordSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.v).toBe(1)
    }
  })

  it('get returns null for an unknown fileId', async () => {
    const store = new CanvasFileStore()
    expect(await store.get('does-not-exist')).toBeNull()
  })
})
