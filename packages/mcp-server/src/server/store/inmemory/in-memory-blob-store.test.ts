import { describeBlobStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe } from 'vitest'
import { InMemoryBlobStore } from './in-memory-blob-store.js'

describe('InMemoryBlobStore', () => {
  // Every guarantee this file used to spell out by hand now lives in the
  // port's own conformance suite, so the three implementations cannot drift
  // into three different readings of "content-addressed".
  describeBlobStoreConformance(async () => ({
    store: new InMemoryBlobStore(),
    dispose: async () => {},
  }))
})
