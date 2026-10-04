import { describe, expect, it } from 'vitest'
import type { DocumentIndex, DocumentTrash } from '../index.js'
import { WorkspaceNotFoundError } from '../index.js'

type TrashingIndex = DocumentIndex & DocumentTrash

type MakeTrashingIndex = () => Promise<{
  index: TrashingIndex
  dispose: () => Promise<void>
}>

const WS = 'ws-trash-conformance'
// A well-formed id the trash never held.
const ABSENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

type WithIndex = (body: (index: TrashingIndex) => Promise<void>) => Promise<void>

/** Creates a document and deletes it, answering the id the trash will hold. */
async function trashed(index: TrashingIndex, path: string, workspaceId = WS): Promise<string> {
  const { documentId } = await index.createDocument({ workspaceId, path, kind: 'markdown' })
  await index.deleteDocument({ workspaceId, path })
  return documentId
}

const trashIds = async (index: TrashingIndex, workspaceId = WS) =>
  (await index.listTrash({ workspaceId })).map((entry) => entry.documentId)

/**
 * What `DocumentTrash` promises beyond its signature, for every index that
 * keeps a trash. Separate from `describeDocumentIndexConformance` for the
 * reason pinning is: the legacy row-backed index keeps no trash, and a case
 * there would be one it could only fail.
 */
export function describeDocumentTrashConformance(makeIndex: MakeTrashingIndex): void {
  const withIndex: WithIndex = async (body) => {
    const { index, dispose } = await makeIndex()
    try {
      await index.createWorkspace({ workspaceId: WS })
      await index.createWorkspace({ workspaceId: 'ws-other' })
      await body(index)
    } finally {
      await dispose()
    }
  }

  describe('DocumentTrash', () => {
    it('lists a deleted document and restores it under the id it had', async () => {
      await withIndex(async (index) => {
        const documentId = await trashed(index, 'a')

        await expect(trashIds(index)).resolves.toEqual([documentId])
        const restored = await index.restoreDocument({ workspaceId: WS, documentId })

        expect(restored?.documentId).toBe(documentId)
        await expect(trashIds(index)).resolves.toEqual([])
      })
    })

    describePurgeEffect(withIndex)
    describePurgeRefusals(withIndex)
  })
}

function describePurgeEffect(withIndex: WithIndex): void {
  it('purges a trashed document: gone from the listing, and it cannot be restored', async () => {
    await withIndex(async (index) => {
      const documentId = await trashed(index, 'a')

      await expect(index.purgeTrashEntry({ workspaceId: WS, documentId })).resolves.toBe(true)

      await expect(trashIds(index)).resolves.toEqual([])
      await expect(index.restoreDocument({ workspaceId: WS, documentId })).resolves.toBeNull()
      await expect(index.resolveDocumentById({ workspaceId: WS, documentId })).resolves.toBeNull()
    })
  })

  it('purges only the entry it names', async () => {
    await withIndex(async (index) => {
      const kept = await trashed(index, 'a')
      const purged = await trashed(index, 'b')

      await index.purgeTrashEntry({ workspaceId: WS, documentId: purged })

      await expect(trashIds(index)).resolves.toEqual([kept])
      await expect(
        index.restoreDocument({ workspaceId: WS, documentId: kept }),
      ).resolves.not.toBeNull()
    })
  })
}

function describePurgeRefusals(withIndex: WithIndex): void {
  it('refuses a document that is live, not trashed, and leaves it alone', async () => {
    await withIndex(async (index) => {
      const { documentId } = await index.createDocument({
        workspaceId: WS,
        path: 'live',
        kind: 'markdown',
      })

      await expect(index.purgeTrashEntry({ workspaceId: WS, documentId })).resolves.toBe(false)

      await expect(
        index.resolveDocumentById({ workspaceId: WS, documentId }),
      ).resolves.not.toBeNull()
    })
  })

  it('answers false for an id the trash never held, and again for one already purged', async () => {
    await withIndex(async (index) => {
      const documentId = await trashed(index, 'a')

      await expect(index.purgeTrashEntry({ workspaceId: WS, documentId: ABSENT_ID })).resolves.toBe(
        false,
      )
      await index.purgeTrashEntry({ workspaceId: WS, documentId })
      await expect(index.purgeTrashEntry({ workspaceId: WS, documentId })).resolves.toBe(false)
    })
  })

  it('does not reach into another workspace trash', async () => {
    await withIndex(async (index) => {
      const documentId = await trashed(index, 'a', 'ws-other')

      await expect(index.purgeTrashEntry({ workspaceId: WS, documentId })).resolves.toBe(false)

      await expect(trashIds(index, 'ws-other')).resolves.toEqual([documentId])
    })
  })

  it('refuses a workspace the index does not hold, as listTrash does', async () => {
    await withIndex(async (index) => {
      await expect(
        index.purgeTrashEntry({ workspaceId: 'ws-nobody', documentId: ABSENT_ID }),
      ).rejects.toThrow(WorkspaceNotFoundError)
    })
  })
}
