import { describe } from 'vitest'
import { describeDocumentIndexConformance } from './document-index-conformance.js'
import { describeDocumentPinsConformance } from './document-pins-conformance.js'
import { InMemoryDocumentIndex } from './in-memory-document-index.js'

// The same suite the sqlite store answers to, run here so the double cannot
// drift from the guarantees while still satisfying the interface.
describe('InMemoryDocumentIndex', () => {
  describeDocumentIndexConformance(async () => {
    const index = new InMemoryDocumentIndex()
    return {
      index,
      dispose: async () => {},
      // Unchecked, unlike `createWorkspace`: the seam stands for whatever a
      // registry already holds, including rows from before a bound.
      seedWorkspace: async (entry) => index.seedWorkspace(entry),
    }
  })
})

describe('InMemoryDocumentIndex pins', () => {
  describeDocumentPinsConformance(async () => ({
    index: new InMemoryDocumentIndex(),
    dispose: async () => {},
  }))
})
