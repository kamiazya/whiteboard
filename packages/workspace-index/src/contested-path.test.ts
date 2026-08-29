/**
 * Contested paths — the one state a row-backed index can never be in
 * (UNIQUE constraint) and a converged tree can: two replicas each created
 * a document at the same path and both survived the merge.
 *
 * The decided behavior (dual-plane collapse S5b): the LISTING shows both,
 * with the later sibling marked `shadowed` — hiding converged data reads
 * as loss — while resolution BY PATH refuses: an agent naming a contested
 * path gets an error to act on (resolve by id, or rename one), never a
 * silent pick of whichever sibling tree order favors.
 */
import type { BlobStore } from '@kamiazya/whiteboard-ports'
import { DocumentPathContestedError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import type { WorkspaceDocs } from './workspace-docs.js'

const OWNER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const RIVAL_ID = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

function singleDocWorkspaceDocs(doc: LoroDoc): WorkspaceDocs {
  return {
    async open() {
      return doc
    },
    async create() {
      return doc
    },
    async save() {
      return null
    },
    // These doubles serve INDEX tests, which never tail. Rejecting rather than
    // answering an empty cursor: a silent no-op would let a tailing test pass
    // against a double that cannot tail.
    readCursor: () => Promise.reject(new Error('not implemented')),
    catchUp: () => Promise.reject(new Error('not implemented')),
  }
}

const unusedBlobStore = {} as BlobStore

async function contestedIndex(): Promise<LoroWorkspaceDocumentIndex> {
  const { createWorkspaceDocumentAtPath } = await import('@kamiazya/whiteboard-loro-adapter')
  // Two replicas each create 'design' concurrently; both survive the merge
  // — the arrangement no local uniqueness check can prevent.
  const doc = new LoroDoc()
  doc.setPeerId(1n)
  const replica = new LoroDoc()
  replica.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, { path: 'design', documentId: OWNER_ID, kind: 'spatial' })
  createWorkspaceDocumentAtPath(replica, {
    path: 'design',
    documentId: RIVAL_ID,
    kind: 'markdown',
  })
  doc.import(replica.export({ mode: 'update' }))

  return new LoroWorkspaceDocumentIndex(singleDocWorkspaceDocs(doc), unusedBlobStore, {
    listWorkspaces: async () => [],
  })
}

describe('contested paths', () => {
  it('lists BOTH documents, the later sibling marked shadowed', async () => {
    const index = await contestedIndex()
    const listing = await index.listDocuments({ workspaceId: 'ws' })
    const atPath = listing.filter((entry) => entry.path === 'design')
    expect(atPath).toHaveLength(2)
    expect(atPath.filter((entry) => entry.shadowed === true)).toHaveLength(1)
  })

  it('refuses to resolve a contested path instead of silently picking the owner', async () => {
    const index = await contestedIndex()
    await expect(index.resolveDocument({ workspaceId: 'ws', path: 'design' })).rejects.toThrow(
      DocumentPathContestedError,
    )
  })

  it('still resolves each contestant by id', async () => {
    const index = await contestedIndex()
    const owner = await index.resolveDocumentById({ workspaceId: 'ws', documentId: OWNER_ID })
    const rival = await index.resolveDocumentById({ workspaceId: 'ws', documentId: RIVAL_ID })
    expect(owner?.path).toBe('design')
    expect(rival?.path).toBe('design')
  })

  it('an uncontested path still resolves normally', async () => {
    const { createWorkspaceDocumentAtPath } = await import('@kamiazya/whiteboard-loro-adapter')
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'solo', documentId: OWNER_ID, kind: 'spatial' })
    const index = new LoroWorkspaceDocumentIndex(singleDocWorkspaceDocs(doc), unusedBlobStore, {
      listWorkspaces: async () => [],
    })
    const entry = await index.resolveDocument({ workspaceId: 'ws', path: 'solo' })
    expect(entry?.documentId).toBe(OWNER_ID)
    expect(entry?.shadowed).toBeUndefined()
  })
})
