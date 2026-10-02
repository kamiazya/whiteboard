import type { BlobRef } from './blob-store.js'

/**
 * The key a `BlobRef` is stored under wherever a store keeps blobs in a map:
 * the in-memory double's `Map`, and the browser's IndexedDB primary key. The
 * algorithm is part of it, so a second algorithm introduced later cannot
 * collide with a sha-256 digest that happens to share its hex.
 *
 * It lives in `ports` for the reason `docRefKey` does: the IndexedDB key is a
 * STORED value, and two stores that spell it differently cannot read each
 * other's rows with nothing at compile time to say so. The filesystem store
 * addresses by path instead, and that spelling is `data-layout`'s.
 */
export function blobRefKey(ref: BlobRef): string {
  return `${ref.algorithm}:${ref.digestHex}`
}
