/**
 * Contested paths — the one state a row-backed index can never be in
 * (UNIQUE constraint) and a converged tree can: two replicas each created
 * a document at the same path and both survived the merge.
 *
 * The decided behavior (dual-plane collapse): the LISTING shows both,
 * with the later sibling marked `shadowed` — hiding converged data reads
 * as loss — while resolution BY PATH refuses: an agent naming a contested
 * path gets an error to act on (resolve by id, or rename one), never a
 * silent pick of whichever sibling tree order favors.
 */
import { type BlobStore, DocumentPathContestedError } from '@kamiazya/whiteboard-ports'
import { describe, expect, it } from 'vitest'
import type { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import { INDEX_SUBJECTS, type IndexSubject, indexOver } from './test-utils/index-subjects.js'
import type { WorkspaceDocs } from './workspace-docs.js'

const OWNER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const RIVAL_ID = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

function singleRecordWorkspaceDocs(subject: IndexSubject, record: unknown): WorkspaceDocs<unknown> {
  return {
    async open() {
      return subject.borrow(record)
    },
    async create() {
      return subject.borrow(record)
    },
    async save() {
      return null
    },
    // These doubles serve INDEX tests, which never tail. Rejecting rather than
    // answering an empty cursor: a silent no-op would let a tailing test pass
    // against a double that cannot tail.
    readCursor: () => Promise.reject(new Error('not implemented')),
    catchUp: () => Promise.reject(new Error('not implemented')),
    storedVersion: () => Promise.reject(new Error('not implemented')),
  }
}

const unusedBlobStore = {} as BlobStore

async function contestedIndex(subject: IndexSubject): Promise<LoroWorkspaceDocumentIndex<unknown>> {
  // Two replicas each create 'design' concurrently; both survive the merge
  // — the arrangement no local uniqueness check can prevent.
  const record = await subject.kind.empty()
  const replica = subject.replica(record, 2)
  subject.kind.write(record, [
    {
      op: 'createWorkspaceDocumentAtPath',
      args: { path: 'design', documentId: OWNER_ID, kind: 'spatial' },
    },
  ])
  subject.kind.write(replica, [
    {
      op: 'createWorkspaceDocumentAtPath',
      args: { path: 'design', documentId: RIVAL_ID, kind: 'markdown' },
    },
  ])
  subject.merge(record, replica)

  return indexOver(subject, singleRecordWorkspaceDocs(subject, record), unusedBlobStore)
}

describe.each(INDEX_SUBJECTS)('contested paths over $name', (subject) => {
  it('lists BOTH documents, the later sibling marked shadowed', async () => {
    const index = await contestedIndex(subject)
    const listing = await index.listDocuments({ workspaceId: '0104Y7DY19FTA30KQYKDRRMNBN' })
    const atPath = listing.filter((entry) => entry.path === 'design')
    expect(atPath).toHaveLength(2)
    expect(atPath.filter((entry) => entry.shadowed === true)).toHaveLength(1)
  })

  it('refuses to resolve a contested path instead of silently picking the owner', async () => {
    const index = await contestedIndex(subject)
    await expect(
      index.resolveDocument({ workspaceId: '0104Y7DY19FTA30KQYKDRRMNBN', path: 'design' }),
    ).rejects.toThrow(DocumentPathContestedError)
  })

  it('refuses to duplicate a contested path instead of copying whichever sibling', async () => {
    const index = await contestedIndex(subject)
    await expect(
      index.duplicateDocument({ workspaceId: '0104Y7DY19FTA30KQYKDRRMNBN', path: 'design' }),
    ).rejects.toThrow(DocumentPathContestedError)
    const listing = await index.listDocuments({ workspaceId: '0104Y7DY19FTA30KQYKDRRMNBN' })
    expect(listing.map((entry) => entry.path)).toEqual(['design', 'design'])
  })

  it('still resolves each contestant by id', async () => {
    const index = await contestedIndex(subject)
    const owner = await index.resolveDocumentById({
      workspaceId: '0104Y7DY19FTA30KQYKDRRMNBN',
      documentId: OWNER_ID,
    })
    const rival = await index.resolveDocumentById({
      workspaceId: '0104Y7DY19FTA30KQYKDRRMNBN',
      documentId: RIVAL_ID,
    })
    expect(owner?.path).toBe('design')
    expect(rival?.path).toBe('design')
  })

  it('an uncontested path still resolves normally', async () => {
    const record = await subject.kind.empty()
    subject.kind.write(record, [
      {
        op: 'createWorkspaceDocumentAtPath',
        args: { path: 'solo', documentId: OWNER_ID, kind: 'spatial' },
      },
    ])
    const index = indexOver(subject, singleRecordWorkspaceDocs(subject, record), unusedBlobStore)
    const entry = await index.resolveDocument({
      workspaceId: '0104Y7DY19FTA30KQYKDRRMNBN',
      path: 'solo',
    })
    expect(entry?.documentId).toBe(OWNER_ID)
    expect(entry?.shadowed).toBeUndefined()
  })
})
