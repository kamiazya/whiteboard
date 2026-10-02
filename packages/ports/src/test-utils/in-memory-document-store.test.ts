import { describe } from 'vitest'
import { describeDocumentStoreConformance } from './document-store-conformance.js'
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
