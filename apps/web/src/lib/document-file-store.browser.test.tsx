/**
 * DocumentFileStore — real IndexedDB round-trip tests.
 *
 * Real browser context required for IndexedDB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BLOBS_STORE, openWhiteboardDb } from './browser-idb.js'
import { DocumentFileStore, documentFileRecordSchema } from './document-file-store.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('document-file-store')

/** The bytes read back under `fileId`, or null when the read found no blob. */
async function bytesOf(store: DocumentFileStore, fileId: string): Promise<ArrayBuffer | null> {
  const read = await store.read(fileId)
  return read.kind === 'blob' ? read.blob.arrayBuffer() : null
}

/** Rounds of the put-vs-sweep race: unserialised, most of them lose the image. */
const ROUNDS = 12

describe('DocumentFileStore', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(clearWhiteboardDb)

  it('put then read round-trips a Blob with identical bytes and mimeType', async () => {
    const store = new DocumentFileStore()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const blob = new Blob([bytes], { type: 'image/png' })

    await store.put('file-1', { mimeType: 'image/png', blob, created: 123 })
    const result = await store.read('file-1')

    if (result.kind !== 'blob') throw new Error(`expected a blob, read ${result.kind}`)
    expect(result.blob.type).toBe('image/png')
    const resultBytes = new Uint8Array(await result.blob.arrayBuffer())
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

  it('reads an unknown fileId as absent', async () => {
    const store = new DocumentFileStore()
    expect(await store.read('does-not-exist')).toEqual({ kind: 'absent' })
  })

  it('a put racing a sweep keeps its image when a swept sibling shared its bytes', async () => {
    // Each round stores `old` with bytes B, then sweeps `old` away while
    // `put` maps `new` to the same B. Unserialised, the sweep sees no other
    // mapping to B and deletes it between `put`'s blob write and its mapping
    // write, leaving `new` naming nothing. The staggered start moves `put`'s
    // entry across the sweep's awaits so the rounds reach that window.
    const png = (text: string) => new Blob([new TextEncoder().encode(text)], { type: 'image/png' })
    const lost: number[] = []
    for (let round = 0; round < ROUNDS; round++) {
      await clearWhiteboardDb()
      const bytes = `png:shared-${round}`
      await new DocumentFileStore().put(`asset:old-${round}`, {
        mimeType: 'image/png',
        blob: png(bytes),
        created: 0,
      })
      await Promise.all([
        new DocumentFileStore().sweep(() => false, 1),
        (async () => {
          for (let tick = 0; tick < round % 4; tick++) await Promise.resolve()
          await new DocumentFileStore().put(`asset:new-${round}`, {
            mimeType: 'image/png',
            blob: png(bytes),
            created: Date.now(),
          })
        })(),
      ])
      if ((await new DocumentFileStore().read(`asset:new-${round}`)).kind !== 'blob') {
        lost.push(round)
      }
    }
    expect(lost).toEqual([])
  })
})

describe('DocumentFileStore over the blob store', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(clearWhiteboardDb)

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
    expect(await bytesOf(store, 'file-a')).toEqual(PNG.buffer)
    expect(await bytesOf(store, 'file-b')).toEqual(PNG.buffer)
  })

  it('keeps the bytes while another file still references them', async () => {
    // Deleting one reference must not blank the other's image. This is the
    // half of `delete` that dedup makes non-obvious, and the reason it could
    // not simply be added to the old store.
    const store = new DocumentFileStore()
    await store.put('file-a', { mimeType: 'image/png', blob: new Blob([PNG]), created: 1 })
    await store.put('file-b', { mimeType: 'image/png', blob: new Blob([PNG]), created: 2 })

    await store.delete('file-a')

    expect(await store.read('file-a')).toEqual({ kind: 'absent' })
    expect(await bytesOf(store, 'file-b')).toEqual(PNG.buffer)
    expect(await blobCount()).toBe(1)
  })

  it('drops the bytes once the last reference is gone', async () => {
    // Records used to be undeletable, so the store grew without bound. This
    // is the ticket's other half: the bytes go when nothing names them.
    const store = new DocumentFileStore()
    await store.put('only', { mimeType: 'image/png', blob: new Blob([PNG]), created: 1 })

    await store.delete('only')

    expect(await store.read('only')).toEqual({ kind: 'absent' })
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
    expect(await bytesOf(store, 'legacy')).toEqual(PNG.buffer)

    // Converted: the bytes are in the blob store, and the record now points
    // at them. Polled, because the conversion is deliberately not awaited —
    // it must not delay the image the caller asked for.
    await vi.waitFor(async () => expect(await blobCount()).toBe(1), { timeout: 3000 })
    expect(await bytesOf(store, 'legacy')).toEqual(PNG.buffer)
  })

  it('reads a reference whose bytes are gone as absent, not unreadable', async () => {
    // The record still names the bytes, but nothing is stored under them:
    // the image is missing, and nothing about this device failed.
    const store = new DocumentFileStore()
    await store.put('orphan', { mimeType: 'image/png', blob: new Blob([PNG]), created: 1 })
    const db = await openWhiteboardDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(BLOBS_STORE, 'readwrite')
        tx.objectStore(BLOBS_STORE).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
    expect(await blobCount()).toBe(0)

    expect(await store.read('orphan')).toEqual({ kind: 'absent' })
  })

  it('deleting a file id that was never stored is quiet', async () => {
    await expect(new DocumentFileStore().delete('never-here')).resolves.toBeUndefined()
  })
})
