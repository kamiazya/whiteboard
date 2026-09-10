/**
 * The browser `BlobStore`, held to the port's own conformance suite — the
 * same one the daemon's filesystem and in-memory stores pass, so "content
 * addressed" cannot mean three different things in three places.
 *
 * Nothing is asserted here beyond the contract. What this file adds is the
 * IndexedDB-specific fixture: a real database per case, deleted afterwards,
 * because every conformance case assumes a store that starts empty.
 */
import { describeBlobStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import { IdbBlobStore } from './idb-blob-store.js'

// Its OWN database, not the app's — browser tests share an origin, so
// deleting `whiteboard` between cases would tear it out from under whatever
// other file is mid-fixture, and the failure would land there.
const DB_NAME = 'whiteboard-blob-store-conformance'

describe('IdbBlobStore', () => {
  describeBlobStoreConformance(async () => {
    await clearNamedDb(DB_NAME)
    return {
      store: new IdbBlobStore(DB_NAME),
      dispose: () => clearNamedDb(DB_NAME),
    }
  })
})

describe('IdbBlobStore stored content type', () => {
  it('reads back a blob stored with an empty content type, as a Blob types what it cannot parse', async () => {
    await clearNamedDb(DB_NAME)
    const store = new IdbBlobStore(DB_NAME)
    const bytes = new Uint8Array([1, 2, 3])
    // A type with a character outside printable ASCII is one a Blob will
    // not carry, and what it answers instead is the empty string.
    const untyped = new Blob([bytes], { type: 'image/\u2603' }).type
    expect(untyped).toBe('')
    const { ref } = await store.put({ bytes, contentType: untyped })
    expect(await store.has({ ref })).toEqual({ exists: true })
    const got = await store.get({ ref })
    expect(Array.from(got?.bytes ?? [])).toEqual([1, 2, 3])
    expect(got?.contentType).toBe('')
    await clearNamedDb(DB_NAME)
  })
})
