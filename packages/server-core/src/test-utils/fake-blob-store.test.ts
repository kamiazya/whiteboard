import { describeBlobStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { FakeBlobStore } from './fake-blob-store.js'

describe('FakeBlobStore', () => {
  // A promote test reads "stored under the digest the entry names" off this
  // double, so it has to be a reading of "content-addressed" the keepers share.
  describeBlobStoreConformance(async () => ({
    store: new FakeBlobStore(),
    dispose: async () => {},
  }))

  it('addresses bytes by their lowercase sha-256 hex, as the daemon does', async () => {
    const store = new FakeBlobStore()
    const { ref } = await store.put({ bytes: new TextEncoder().encode('abc') })
    expect(ref).toEqual({
      algorithm: 'sha-256',
      digestHex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    })
  })
})
