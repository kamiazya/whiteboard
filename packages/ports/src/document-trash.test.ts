import { describe, expect, it } from 'vitest'
import type { DocumentIndex } from './document-index.js'
import { hasDocumentTrash } from './document-trash.js'
import { InMemoryDocumentIndex } from './test-utils/in-memory-document-index.js'

const whole = {
  listTrash: async () => [],
  restoreDocument: async () => null,
  purgeTrashEntry: async () => false,
}

describe('hasDocumentTrash', () => {
  it('recognises an index that lists, restores and purges', () => {
    expect(hasDocumentTrash(whole as unknown as DocumentIndex)).toBe(true)
  })

  it('refuses the row-backed index, which deletes outright and keeps no trash', () => {
    expect(hasDocumentTrash(new InMemoryDocumentIndex())).toBe(false)
  })

  it.each([
    'listTrash',
    'restoreDocument',
    'purgeTrashEntry',
  ] as const)('refuses an index missing %s, rather than a method that would throw later', (missing) => {
    const { [missing]: _omitted, ...partial } = whole
    expect(hasDocumentTrash(partial as unknown as DocumentIndex)).toBe(false)
  })
})
