import { describe, expect, it } from 'vitest'
import type { DocumentIndex, WorkspaceEntry } from '../index.js'
import { DisplayNameTakenError } from '../index.js'

// The conformance suite's own fixture shape, restated so this file imports
// nothing back from the suite that calls it.
type WithIndex = (
  body: (index: DocumentIndex, seed: (entry: WorkspaceEntry) => Promise<void>) => Promise<void>,
) => Promise<void>

/**
 * A document's display name is refused when a sibling document under the
 * same parent already shows it — the duplicate the writer can see. Siblings
 * show their name, or unnamed, their segment; folders are a separate
 * question and never collide with a document.
 */
export function describeDuplicateDocumentName(withIndex: WithIndex, workspaceId: string): void {
  const create = (index: DocumentIndex, path: string, name?: string) =>
    index.createDocument({
      workspaceId,
      path,
      kind: 'markdown',
      ...(name === undefined ? {} : { name }),
    })

  describe('a document name a sibling already shows', () => {
    it('is refused on create, compared trimmed, case-folded and NFC-normalised', async () => {
      await withIndex(async (index) => {
        await create(index, 'week/plan', 'Café notes')

        await expect(create(index, 'week/other', ' CAFÉ NOTES ')).rejects.toThrow(
          DisplayNameTakenError,
        )
        const paths = (await index.listDocuments({ workspaceId })).map((entry) => entry.path)
        expect(paths).not.toContain('week/other')
      })
    })

    it('is refused on create when an unnamed sibling shows it as its segment', async () => {
      await withIndex(async (index) => {
        await create(index, 'week/plan')
        await expect(create(index, 'week/other', 'Plan')).rejects.toThrow(DisplayNameTakenError)
      })
    })
  })
  describeDuplicateDocumentRename(withIndex, workspaceId, create)
}

function describeDuplicateDocumentRename(
  withIndex: WithIndex,
  workspaceId: string,
  create: (
    index: DocumentIndex,
    path: string,
    name?: string,
  ) => Promise<{ documentId: string; name?: string }>,
): void {
  describe('a document renamed to a name a sibling already shows', () => {
    it('is refused, and leaves the name as it was', async () => {
      await withIndex(async (index) => {
        await create(index, 'week/plan', 'Plan')
        const { documentId } = await create(index, 'week/other', 'Other')

        await expect(
          index.setDocumentName({ workspaceId, documentId, name: 'plan' }),
        ).rejects.toThrow(DisplayNameTakenError)
        expect((await index.resolveDocumentById({ workspaceId, documentId }))?.name).toBe('Other')
      })
    })

    it('is no duplicate in another folder, beside a folder, or as the document own name', async () => {
      await withIndex(async (index) => {
        await create(index, 'week/plan', 'Plan')
        await create(index, 'month/x/inner')
        const elsewhere = await create(index, 'month/plan', 'Plan')
        const own = await create(index, 'week/other', 'Other')

        // A folder `month/x` stands beside it: folders are another question.
        await create(index, 'month/y', 'X')
        await index.setDocumentName({ workspaceId, documentId: own.documentId, name: 'other' })
        expect(elsewhere.name).toBe('Plan')
        expect(
          (await index.resolveDocumentById({ workspaceId, documentId: own.documentId }))?.name,
        ).toBe('other')
      })
    })

    it('never refuses a clear', async () => {
      await withIndex(async (index) => {
        await create(index, 'week/plan', 'Plan')
        const { documentId } = await create(index, 'week/other', 'Other')
        await index.setDocumentName({ workspaceId, documentId })
        expect((await index.resolveDocumentById({ workspaceId, documentId }))?.name).toBeUndefined()
      })
    })
  })
}
