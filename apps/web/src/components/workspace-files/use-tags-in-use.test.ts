import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { useTagsInUse } from './use-tags-in-use.js'

/** A keeper that cannot count tags, so the strip falls back to the entries. */
const uncounted = {} as WorkspaceFilesSource

describe('useTagsInUse, before the keeper has counted', () => {
  it('counts a spatial document as a board and any other as a document', () => {
    const documents: WorkspaceDocumentEntry[] = [
      { documentId: 'b', path: 'plan', kind: 'spatial', tags: ['ops'] },
      { documentId: 'n', path: 'notes', kind: 'markdown', tags: ['ops'] },
      { documentId: 'u', path: 'unkinded', tags: ['ops'] },
    ]

    const { result } = renderHook(() => useTagsInUse(uncounted, documents))

    expect(result.current.tags).toEqual([
      expect.objectContaining({ tag: 'ops', boards: 1, documents: 2 }),
    ])
  })
})
