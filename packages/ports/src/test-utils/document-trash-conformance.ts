import { describe, expect, it } from 'vitest'
import type { DocumentIndex, DocumentTrash } from '../index.js'
import { WorkspaceNotFoundError } from '../index.js'

type TrashingIndex = DocumentIndex & DocumentTrash

type MakeTrashingIndex = () => Promise<{
  index: TrashingIndex
  /**
   * How many evacuated documents the index's blob store still holds. REQUIRED
   * and not optional: a seam an implementation may omit is skipped by exactly
   * the implementation whose destruction promise needs checking. The suite
   * only ever trashes documents, so every blob counted is an evacuation.
   */
  evacuatedBlobCount: () => Promise<number>
  /**
   * Places a live document under `documentId` at `path` without touching the
   * trash. The port has no operation that does this, and a keeper's own
   * placement paths can: a migration adopting an old record, a page opening a
   * document somebody deleted a moment before. REQUIRED for the reason the
   * blob count is.
   */
  placeDocument: (input: { workspaceId: string; documentId: string; path: string }) => Promise<void>
  dispose: () => Promise<void>
}>

const WS = 'ws-trash-conformance'
// A well-formed id the trash never held.
const ABSENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

type Seams = Omit<Awaited<ReturnType<MakeTrashingIndex>>, 'index' | 'dispose'>

type WithIndex = (
  body: (
    index: TrashingIndex,
    evacuatedBlobCount: Seams['evacuatedBlobCount'],
    seams: Seams,
  ) => Promise<void>,
) => Promise<void>

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
    const { index, dispose, ...seams } = await makeIndex()
    try {
      await index.createWorkspace({ workspaceId: WS })
      await index.createWorkspace({ workspaceId: 'ws-other' })
      await body(index, seams.evacuatedBlobCount, seams)
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

    // Two nodes under one id list twice, and deleting either contests the
    // path. Refused rather than answered with the live one: the trashed copy
    // may hold what the live one lacks, and forgetting its row would lose it.
    it('refuses to restore an id the workspace already places, and adds no node', async () => {
      await withIndex(async (index, _count, { placeDocument }) => {
        const documentId = await trashed(index, 'a')
        await placeDocument({ workspaceId: WS, documentId, path: 'a' })

        await expect(index.restoreDocument({ workspaceId: WS, documentId })).resolves.toBeNull()

        const listed = await index.listDocuments({ workspaceId: WS })
        expect(listed.filter((entry) => entry.documentId === documentId)).toHaveLength(1)
        await expect(trashIds(index)).resolves.toEqual([documentId])
      })
    })

    describeEvacuatedBytes(withIndex)
    describePurgeEffect(withIndex)
    describePurgeRefusals(withIndex)
  })
}

/**
 * The destruction promise is about BYTES, not rows: a delete-restore-delete
 * cycle evacuates different bytes each time (a restored document is a new
 * tree node), so a restore that kept the old blob would leave one readable
 * export per cycle behind an empty Trash.
 */
function describeEvacuatedBytes(withIndex: WithIndex): void {
  it('holds one evacuation per trashed document and none once it is restored', async () => {
    await withIndex(async (index, evacuatedBlobCount) => {
      const documentId = await trashed(index, 'a')
      await expect(evacuatedBlobCount()).resolves.toBe(1)

      await index.restoreDocument({ workspaceId: WS, documentId })

      await expect(evacuatedBlobCount()).resolves.toBe(0)
    })
  })

  it('leaves no evacuated bytes after delete, restore, delete, purge', async () => {
    await withIndex(async (index, evacuatedBlobCount) => {
      const documentId = await trashed(index, 'a')
      await index.restoreDocument({ workspaceId: WS, documentId })
      await index.deleteDocument({ workspaceId: WS, path: 'a' })
      await expect(evacuatedBlobCount()).resolves.toBe(1)

      await index.purgeTrashEntry({ workspaceId: WS, documentId })

      await expect(evacuatedBlobCount()).resolves.toBe(0)
    })
  })

  it('keeps the evacuation of a document that stays in the trash', async () => {
    await withIndex(async (index, evacuatedBlobCount) => {
      const kept = await trashed(index, 'a')
      const restored = await trashed(index, 'b')

      await index.restoreDocument({ workspaceId: WS, documentId: restored })

      await expect(evacuatedBlobCount()).resolves.toBe(1)
      await expect(
        index.restoreDocument({ workspaceId: WS, documentId: kept }),
      ).resolves.not.toBeNull()
    })
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

  it("destroys the purged entry's bytes and keeps the bytes of the entry that stays", async () => {
    await withIndex(async (index, evacuatedBlobCount) => {
      const kept = await trashed(index, 'a')
      const purged = await trashed(index, 'b')
      await expect(evacuatedBlobCount()).resolves.toBe(2)

      await index.purgeTrashEntry({ workspaceId: WS, documentId: purged })

      await expect(evacuatedBlobCount()).resolves.toBe(1)
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
