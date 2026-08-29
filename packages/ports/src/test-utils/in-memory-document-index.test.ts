import { describe } from 'vitest'
import { describeDocumentIndexConformance } from './document-index-conformance.js'
import { InMemoryDocumentIndex } from './in-memory-document-index.js'

// The same suite the sqlite store answers to, run here so the double cannot
// drift from the guarantees while still satisfying the interface.
describe('InMemoryDocumentIndex', () => {
  describeDocumentIndexConformance(async () => {
    const index = new InMemoryDocumentIndex()
    return {
      index,
      dispose: async () => {},
      // This double keeps its registry in the same map `createWorkspace`
      // writes, so the seam is that call.
      seedWorkspace: async (entry) => index.createWorkspace(entry),
    }
  })
})
