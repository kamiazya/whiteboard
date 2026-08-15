import { describe } from 'vitest'
import { describeDocumentIndexConformance } from '../document-index-conformance.js'
import { InMemoryDocumentIndex } from './in-memory-document-index.js'

// The same suite the sqlite store answers to. Two implementations is what
// makes it a conformance suite rather than one store's tests.
describe('InMemoryDocumentIndex', () => {
  describeDocumentIndexConformance(async () => ({
    index: new InMemoryDocumentIndex(),
    dispose: async () => {},
  }))
})
