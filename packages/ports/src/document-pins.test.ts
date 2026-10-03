import { describe, expect, it } from 'vitest'
import type { DocumentIndex } from './document-index.js'
import { hasDocumentPins } from './document-pins.js'
import { InMemoryDocumentIndex } from './test-utils/in-memory-document-index.js'

describe('hasDocumentPins', () => {
  it('recognises an index that keeps a pinned list', () => {
    expect(hasDocumentPins(new InMemoryDocumentIndex())).toBe(true)
  })

  it('refuses an index missing either half, rather than a method that would throw later', () => {
    const onlyList = { listPinnedDocuments: async () => [] } as unknown as DocumentIndex
    expect(hasDocumentPins(onlyList)).toBe(false)
    expect(hasDocumentPins({} as DocumentIndex)).toBe(false)
  })
})
