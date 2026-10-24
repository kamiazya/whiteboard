import { describe, expect, it } from 'vitest'
import { hasDocumentFolders, setFolderNameInputSchema } from './document-folders.js'
import type { DocumentIndex } from './document-index.js'
import { InMemoryDocumentIndex } from './test-utils/in-memory-document-index.js'

describe('hasDocumentFolders', () => {
  it('recognises an index that names folders', () => {
    const index = {
      listFolderNames: async () => [],
      setFolderName: async () => {},
    } as unknown as DocumentIndex
    expect(hasDocumentFolders(index)).toBe(true)
  })

  it('refuses a row-backed index, and one missing either half', () => {
    expect(hasDocumentFolders(new InMemoryDocumentIndex())).toBe(false)
    const onlyList = { listFolderNames: async () => [] } as unknown as DocumentIndex
    expect(hasDocumentFolders(onlyList)).toBe(false)
  })
})

describe('setFolderNameInputSchema', () => {
  const input = { workspaceId: 'ws', path: 'week-6' }

  it('takes a name, or none to clear', () => {
    expect(setFolderNameInputSchema.safeParse({ ...input, name: 'Week 6' }).success).toBe(true)
    expect(setFolderNameInputSchema.safeParse(input).success).toBe(true)
  })

  it('refuses a blank name, a "/" and a stray key', () => {
    expect(setFolderNameInputSchema.safeParse({ ...input, name: ' ' }).success).toBe(false)
    expect(setFolderNameInputSchema.safeParse({ ...input, name: 'a/b' }).success).toBe(false)
    expect(setFolderNameInputSchema.safeParse({ ...input, label: 'x' }).success).toBe(false)
  })
})
