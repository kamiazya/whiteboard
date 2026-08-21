import { describe, expect, it } from 'vitest'
import type { BlobRef, BlobStore } from '../index.js'

/**
 * The `BlobStore` guarantees a TypeScript signature cannot carry, as tests
 * every implementation has to pass.
 *
 * A factory rather than tests written against one store, for the same reason
 * `describeDocumentIndexConformance` is: there are three implementations now
 * (in-memory, filesystem, IndexedDB) and "content-addressed" has to mean the
 * same thing in all three or a blob written by one is unreachable through
 * another.
 *
 * The digest is computed here with WebCrypto rather than `node:crypto` —
 * this package must run unchanged in a browser, and arch-lint enforces it.
 */
export function describeBlobStoreConformance(
  makeStore: () => Promise<{ store: BlobStore; dispose: () => Promise<void> }>,
): void {
  async function withStore(body: (store: BlobStore) => Promise<void>): Promise<void> {
    const { store, dispose } = await makeStore()
    try {
      await body(store)
    } finally {
      await dispose()
    }
  }

  async function expectedDigest(bytes: Uint8Array): Promise<string> {
    // Copied rather than passed through: since TS 5.7 a `Uint8Array` is
    // generic over its buffer, and `Uint8Array<ArrayBufferLike>` does not
    // satisfy `BufferSource` — which this package cannot name anyway, having
    // no DOM lib. `new Uint8Array(bytes)` is `Uint8Array<ArrayBuffer>` and
    // needs no cast in either place.
    const buffer = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
    return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  const HELLO = new TextEncoder().encode('hello blob')
  const OTHER = new TextEncoder().encode('a different blob')
  const ABSENT: BlobRef = { algorithm: 'sha-256', digestHex: 'f'.repeat(64) }

  describe('BlobStore conformance', () => {
    it('put returns the real sha-256 of the bytes, lowercase hex', async () => {
      await withStore(async (store) => {
        const { ref } = await store.put({ bytes: HELLO })
        expect(ref.algorithm).toBe('sha-256')
        expect(ref.digestHex).toBe(await expectedDigest(HELLO))
      })
    })

    it('is content-addressed: identical bytes yield the same ref', async () => {
      await withStore(async (store) => {
        const first = await store.put({ bytes: HELLO })
        const second = await store.put({ bytes: new TextEncoder().encode('hello blob') })
        expect(second.ref).toEqual(first.ref)
      })
    })

    it('gives distinct refs to distinct bytes', async () => {
      await withStore(async (store) => {
        const a = await store.put({ bytes: HELLO })
        const b = await store.put({ bytes: OTHER })
        expect(b.ref.digestHex).not.toBe(a.ref.digestHex)
      })
    })

    it('round-trips the bytes and the contentType', async () => {
      await withStore(async (store) => {
        const { ref } = await store.put({ bytes: HELLO, contentType: 'image/png' })
        const got = await store.get({ ref })
        expect(got).not.toBeNull()
        expect([...(got?.bytes ?? [])]).toEqual([...HELLO])
        expect(got?.contentType).toBe('image/png')
      })
    })

    it('omits contentType rather than inventing one', async () => {
      await withStore(async (store) => {
        const { ref } = await store.put({ bytes: HELLO })
        expect((await store.get({ ref }))?.contentType).toBeUndefined()
      })
    })

    it('has answers true after a put and false for a ref never stored', async () => {
      await withStore(async (store) => {
        const { ref } = await store.put({ bytes: HELLO })
        expect(await store.has({ ref })).toEqual({ exists: true })
        expect(await store.has({ ref: ABSENT })).toEqual({ exists: false })
      })
    })

    it('delete removes the blob, so has is false and get is null', async () => {
      await withStore(async (store) => {
        const { ref } = await store.put({ bytes: HELLO })
        await store.delete({ ref })
        expect(await store.has({ ref })).toEqual({ exists: false })
        expect(await store.get({ ref })).toBeNull()
      })
    })

    it('is total on a ref it never stored: get null, has false, delete quiet', async () => {
      // A caller holding a stale ref is ordinary — a document outlives the
      // blob it references. Every read has to answer rather than throw, or
      // one missing attachment takes the page with it.
      await withStore(async (store) => {
        expect(await store.get({ ref: ABSENT })).toBeNull()
        expect(await store.has({ ref: ABSENT })).toEqual({ exists: false })
        await expect(store.delete({ ref: ABSENT })).resolves.toBeUndefined()
      })
    })

    it('stores empty bytes as a blob, not as nothing', async () => {
      await withStore(async (store) => {
        const { ref } = await store.put({ bytes: new Uint8Array(0) })
        expect(await store.has({ ref })).toEqual({ exists: true })
        expect((await store.get({ ref }))?.bytes.length).toBe(0)
      })
    })

    it('does not let a caller mutate the stored bytes after the fact', async () => {
      // The array a caller hands to `put` is theirs to keep using. A store
      // that keeps the same reference hands every later reader whatever the
      // caller did to it next — and for a CONTENT-addressed store that means
      // bytes that no longer hash to the ref they are filed under.
      await withStore(async (store) => {
        const mine = new TextEncoder().encode('mutate me')
        const { ref } = await store.put({ bytes: mine })
        mine[0] = 0
        expect((await store.get({ ref }))?.bytes[0]).toBe('m'.charCodeAt(0))
      })
    })

    it('keeps one blob addressable after a neighbour is deleted', async () => {
      await withStore(async (store) => {
        const keep = await store.put({ bytes: HELLO })
        const drop = await store.put({ bytes: OTHER })
        await store.delete({ ref: drop.ref })
        expect(await store.has({ ref: keep.ref })).toEqual({ exists: true })
      })
    })
  })
}
