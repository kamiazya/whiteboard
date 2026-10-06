import { describeBlobStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe } from 'vitest'
import { FakeBlobStore } from './fake-blob-store.js'

describe('FakeBlobStore', () => {
  // A promote test reads "stored under the digest the entry names" off this
  // double, so it has to be a reading of "content-addressed" the keepers share.
  describeBlobStoreConformance(async () => ({
    store: new FakeBlobStore(),
    dispose: async () => {},
  }))
})
