import { describe, expect, it } from 'vitest'
import type { DocumentIndex, DocumentPins } from '../index.js'
import { DocumentNotFoundError, WorkspaceNotFoundError } from '../index.js'

type PinningIndex = DocumentIndex & DocumentPins

type MakePinningIndex = () => Promise<{
  index: PinningIndex
  dispose: () => Promise<void>
}>

const WS = 'ws-pins'
// A well-formed id the index never assigned.
const ABSENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

/**
 * What `DocumentPins` promises beyond its signature, for every index that
 * keeps a pinned list. Separate from `describeDocumentIndexConformance`
 * because pinning is a capability of the index that holds the workspace
 * record, not of every `DocumentIndex` (the legacy row-backed one keeps no
 * list), and a case there would be one the row-backed index could only fail.
 */
type WithIndex = (body: (index: PinningIndex) => Promise<void>) => Promise<void>

async function create(index: PinningIndex, path: string, workspaceId = WS): Promise<string> {
  return (await index.createDocument({ workspaceId, path, kind: 'markdown' })).documentId
}

const pin = (index: PinningIndex, documentId: string, pinned: boolean) =>
  index.setDocumentPinned({ workspaceId: WS, documentId, pinned })

const pinned = (index: PinningIndex, workspaceId = WS) => index.listPinnedDocuments({ workspaceId })

/**
 * What `DocumentPins` promises beyond its signature, for every index that
 * keeps a pinned list. Separate from `describeDocumentIndexConformance`
 * because pinning is a capability of the index that holds the workspace
 * record, not of every `DocumentIndex` (the legacy row-backed one keeps no
 * list), and a case there would be one the row-backed index could only fail.
 */
export function describeDocumentPinsConformance(makeIndex: MakePinningIndex): void {
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

  describe('DocumentPins', () => {
    describePinOrder(withIndex)
    describePinIdentity(withIndex)
    describePinRefusals(withIndex)
  })
}

function describePinOrder(withIndex: WithIndex): void {
  it('lists nothing pinned for a workspace nobody pinned in', async () => {
    await withIndex(async (index) => {
      await create(index, 'a')
      await expect(pinned(index)).resolves.toEqual([])
    })
  })

  it('lists pinned documents in the order they were pinned, not path order', async () => {
    await withIndex(async (index) => {
      const a = await create(index, 'a')
      const b = await create(index, 'b')
      await pin(index, b, true)
      await pin(index, a, true)

      await expect(pinned(index)).resolves.toEqual([b, a])
    })
  })

  it('keeps its position when pinned again', async () => {
    await withIndex(async (index) => {
      const a = await create(index, 'a')
      const b = await create(index, 'b')
      await pin(index, a, true)
      await pin(index, b, true)
      await pin(index, a, true)

      await expect(pinned(index)).resolves.toEqual([a, b])
    })
  })

  it('removes a document on unpin and treats unpinning an unpinned one as done', async () => {
    await withIndex(async (index) => {
      const a = await create(index, 'a')
      const b = await create(index, 'b')
      await pin(index, a, true)
      await pin(index, b, true)

      await pin(index, a, false)
      await pin(index, a, false)

      await expect(pinned(index)).resolves.toEqual([b])
    })
  })
}

function describePinIdentity(withIndex: WithIndex): void {
  it('follows a document across a move, because a pin is on the id and not the path', async () => {
    await withIndex(async (index) => {
      const a = await create(index, 'a')
      await pin(index, a, true)

      await index.moveDocument({ workspaceId: WS, from: 'a', to: 'z' })

      await expect(pinned(index)).resolves.toEqual([a])
    })
  })

  it('stops listing a document once it is deleted', async () => {
    await withIndex(async (index) => {
      const a = await create(index, 'a')
      const b = await create(index, 'b')
      await pin(index, a, true)
      await pin(index, b, true)

      await index.deleteDocument({ workspaceId: WS, path: 'a' })

      await expect(pinned(index)).resolves.toEqual([b])
    })
  })

  it('keeps one workspace pins out of another', async () => {
    await withIndex(async (index) => {
      const a = await create(index, 'a')
      await create(index, 'a', 'ws-other')
      await pin(index, a, true)

      await expect(pinned(index, 'ws-other')).resolves.toEqual([])
    })
  })
}

function describePinRefusals(withIndex: WithIndex): void {
  it('refuses to pin a document that is not in the workspace', async () => {
    await withIndex(async (index) => {
      const elsewhere = await create(index, 'a', 'ws-other')

      await expect(pin(index, ABSENT_ID, true)).rejects.toThrow(DocumentNotFoundError)
      await expect(pin(index, elsewhere, true)).rejects.toThrow(DocumentNotFoundError)
      await expect(pinned(index)).resolves.toEqual([])
    })
  })

  it('refuses a workspace the index does not hold, as listDocuments does', async () => {
    await withIndex(async (index) => {
      await expect(pinned(index, 'ws-nobody')).rejects.toThrow(WorkspaceNotFoundError)
    })
  })
}
