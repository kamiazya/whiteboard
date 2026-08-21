/**
 * DocumentFileStore — real IndexedDB round-trip tests.
 *
 * Real browser context required for IndexedDB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLOBS_STORE, openWhiteboardDb } from './browser-idb.js'
import { DocumentFileStore, documentFileRecordSchema } from './document-file-store.js'

// Rejects on failure: silently keeping stale fixed-key records would let
// these persistence tests pass without exercising the current write.
// 'blocked' is NOT a failure — store operations close their connections in
// tx.oncomplete, which can land after the op's promise resolves, so the
// deletion is briefly blocked and then proceeds (onsuccess still fires).
// Waiting keeps that benign race quiet; a genuinely stuck connection still
// surfaces as a loud test timeout.
async function clearDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('whiteboard database deletion failed'))
    req.onblocked = () => {
      console.warn(
        'clearDb: whiteboard database deletion blocked — waiting for open connections to close',
      )
    }
  })
}

describe('DocumentFileStore', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('put then get round-trips a Blob with identical bytes and mimeType', async () => {
    const store = new DocumentFileStore()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const blob = new Blob([bytes], { type: 'image/png' })

    await store.put('file-1', { mimeType: 'image/png', blob, created: 123 })
    const result = await store.get('file-1')

    expect(result).not.toBeNull()
    expect(result?.type).toBe('image/png')
    const resultBytes = new Uint8Array(await (result as Blob).arrayBuffer())
    expect(Array.from(resultBytes)).toEqual(Array.from(bytes))
  })

  it('stored record carries v:2 and a ref, not the bytes', async () => {
    const store = new DocumentFileStore()
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' })
    await store.put('file-1', { mimeType: 'image/png', blob, created: 123 })

    const db = await openWhiteboardDb()
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('documentFiles', 'readonly')
      const req = tx.objectStore('documentFiles').get('file-1')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
    const parsed = documentFileRecordSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.v === 2) {
      // The bytes are NOT here any more — that is the whole change. A record
      // still carrying a Blob would parse as v1 and this assertion would
      // report the version rather than quietly accepting either shape.
      expect(parsed.data.ref.algorithm).toBe('sha-256')
      expect(parsed.data.ref.digestHex).toMatch(/^[0-9a-f]{64}$/)
    } else {
      expect.unreachable('record should parse as the v2 envelope')
    }
  })

  it('get returns null for an unknown fileId', async () => {
    const store = new DocumentFileStore()
    expect(await store.get('does-not-exist')).toBeNull()
  })
})

describe('DocumentFileStore over the blob store', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  async function blobCount(): Promise<number> {
    const db = await openWhiteboardDb()
    try {
      return await new Promise<number>((resolve, reject) => {
        const req = db.transaction(BLOBS_STORE, 'readonly').objectStore(BLOBS_STORE).count()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  }

  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

  it('stores identical bytes once, however many files reference them', async () => {
    // The whole reason for content addressing. Two file ids are two
    // references, not two copies — the same image pasted into two documents
    // used to be stored twice, forever, because nothing here could tell.
    const store = new DocumentFileStore()
    await store.put('file-a', { mimeType: 'image/png', blob: new Blob([PNG]), created: 1 })
    await store.put('file-b', { mimeType: 'image/png', blob: new Blob([PNG]), created: 2 })

    expect(await blobCount()).toBe(1)
    expect(await (await store.get('file-a'))?.arrayBuffer()).toEqual(PNG.buffer)
    expect(await (await store.get('file-b'))?.arrayBuffer()).toEqual(PNG.buffer)
  })

  it('keeps the bytes while another file still references them', async () => {
    // Deleting one reference must not blank the other's image. This is the
    // half of `delete` that dedup makes non-obvious, and the reason it could
    // not simply be added to the old store.
    const store = new DocumentFileStore()
    await store.put('file-a', { mimeType: 'image/png', blob: new Blob([PNG]), created: 1 })
    await store.put('file-b', { mimeType: 'image/png', blob: new Blob([PNG]), created: 2 })

    await store.delete('file-a')

    expect(await store.get('file-a')).toBeNull()
    expect(await (await store.get('file-b'))?.arrayBuffer()).toEqual(PNG.buffer)
    expect(await blobCount()).toBe(1)
  })

  it('drops the bytes once the last reference is gone', async () => {
    // Records used to be undeletable, so the store grew without bound. This
    // is the ticket's other half: the bytes go when nothing names them.
    const store = new DocumentFileStore()
    await store.put('only', { mimeType: 'image/png', blob: new Blob([PNG]), created: 1 })

    await store.delete('only')

    expect(await store.get('only')).toBeNull()
    expect(await blobCount()).toBe(0)
  })

  it('reads a v1 record and converts it in place', async () => {
    // Records written before the blob store existed hold the Blob itself.
    // They still have to display — and a read is the moment their bytes are
    // in hand, so it is also the cheapest moment to move them.
    const db = await openWhiteboardDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('documentFiles', 'readwrite')
      tx.objectStore('documentFiles').put(
        { v: 1, mimeType: 'image/png', created: 7, blob: new Blob([PNG]) },
        'legacy',
      )
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    })

    const store = new DocumentFileStore()
    expect(await (await store.get('legacy'))?.arrayBuffer()).toEqual(PNG.buffer)

    // Converted: the bytes are in the blob store, and the record now points
    // at them. Polled, because the conversion is deliberately not awaited —
    // it must not delay the image the caller asked for.
    await vi.waitFor(async () => expect(await blobCount()).toBe(1), { timeout: 3000 })
    expect(await (await store.get('legacy'))?.arrayBuffer()).toEqual(PNG.buffer)
  })

  it('deleting a file id that was never stored is quiet', async () => {
    await expect(new DocumentFileStore().delete('never-here')).resolves.toBeUndefined()
  })
})
