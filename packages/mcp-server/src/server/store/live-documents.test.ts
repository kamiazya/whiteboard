import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import { describe, expect, it, vi } from 'vitest'

// The store is replaced at its save seam only: the translation under test is
// what `liveDocuments().create` does with the error the store throws.
vi.mock('./document-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./document-store.js')>()
  return {
    ...actual,
    saveDocumentBytes: vi.fn(async (_workspaceId: string, path: string) => {
      if (path === 'taken') throw new actual.ConflictError('Document already exists')
      if (path === 'broken') throw new Error('disk gone')
    }),
  }
})

const { liveDocuments } = await import('./live-documents.js')

describe('liveDocuments().create', () => {
  it("turns the store's ConflictError into the port's DocumentPathTakenError", async () => {
    await expect(
      liveDocuments().create('ws-1', 'taken', new Uint8Array(), {}),
    ).rejects.toBeInstanceOf(DocumentPathTakenError)
  })

  it('lets any other failure through unchanged', async () => {
    await expect(liveDocuments().create('ws-1', 'broken', new Uint8Array(), {})).rejects.toThrow(
      'disk gone',
    )
  })
})
