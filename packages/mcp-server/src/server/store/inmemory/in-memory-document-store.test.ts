import { describeDocumentStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe } from 'vitest'
import { InMemoryDocumentStore } from './in-memory-document-store.js'

describe('InMemoryDocumentStore', () => {
  // Every guarantee this file used to spell out by hand is in the port's own
  // conformance suite now, so three implementations cannot drift into three
  // readings of the same contract.
  describeDocumentStoreConformance(async () => {
    const store = new InMemoryDocumentStore()
    return {
      store,
      dispose: async () => {},
      writeUnreadableRecord: async (docRef) => store.writeUnreadableRecord(docRef),
    }
  })
})
