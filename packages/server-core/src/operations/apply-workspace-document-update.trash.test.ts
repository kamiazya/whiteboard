/**
 * A workspace-document update may remove documents — a caller holding
 * `workspace:write` organises the tree that way — and a removal that reaches
 * the record by sync must leave the document as recoverable as the keeper's
 * own delete does: a trash row naming bytes this keeper holds, written before
 * the removal is saved.
 */
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  deleteWorkspaceNodeAtPath,
  documentContainers,
  importWorkspaceSubtree,
  MARKDOWN_BODY_KEY,
  readTrashEntries,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import type { BlobStore } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { FakeBlobStore } from '../test-utils/fake-blob-store.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'

const WS = 'ws-1'
const NOTE = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const CHILD = '01BRWAAAAAAAAAAAAAAAAAAAA2'
const OTHER = '01BRWAAAAAAAAAAAAAAAAAAAA3'

function seed(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'note', documentId: NOTE, kind: 'markdown' })
  documentContainers(doc, NOTE).getText(MARKDOWN_BODY_KEY).insert(0, '# kept words')
  createWorkspaceDocumentAtPath(doc, { path: 'note/child', documentId: CHILD, kind: 'markdown' })
  createWorkspaceDocumentAtPath(doc, { path: 'folder/other', documentId: OTHER, kind: 'markdown' })
  doc.commit()
  return doc
}

function deps(store: StoredDoc, blobStore: BlobStore) {
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    get: async () => store.get(),
    save: async (_workspaceId, doc) => store.save(doc),
    evict: () => store.evict(),
    evictProjections: () => {},
  }
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
  }
  return { workspaceDocuments, liveDocuments, blobStore }
}

function updateFrom(store: StoredDoc, edit: (replica: LoroDoc) => void): Uint8Array {
  const replica = store.get().fork()
  const from = replica.oplogVersion()
  edit(replica)
  replica.commit()
  return replica.export({ mode: 'update', from })
}

async function restoredFrom(blobs: FakeBlobStore, documentId: string, store: StoredDoc) {
  const entry = readTrashEntries(store.get()).find((row) => row.documentId === documentId)
  if (entry === undefined) return null
  const held = await blobs.get({ ref: entry.blob })
  if (held === null) return null
  const scratch = new LoroDoc()
  importWorkspaceSubtree(scratch, held.bytes)
  return scratch
}

describe('a workspace-document update that removes a document', () => {
  it('leaves it in the trash, restorable from bytes this keeper holds', async () => {
    const store = new StoredDoc(seed())
    const blobs = new FakeBlobStore()
    const update = updateFrom(store, (replica) =>
      deleteWorkspaceDocument(replica, { documentId: OTHER }),
    )

    const result = await applyWorkspaceDocumentUpdate(deps(store, blobs), {
      workspaceId: WS,
      update,
    })

    expect(result).toMatchObject({ kind: 'applied' })
    expect(readTrashEntries(store.get())).toMatchObject([
      { documentId: OTHER, path: 'folder/other' },
    ])
    const restored = await restoredFrom(blobs, OTHER, store)
    expect(restored && readWorkspaceDocuments(restored).map((each) => each.documentId)).toEqual([
      OTHER,
    ])
  })

  it('keeps the content, and the documents below it, in what the trash names', async () => {
    const store = new StoredDoc(seed())
    const blobs = new FakeBlobStore()
    const update = updateFrom(store, (replica) =>
      deleteWorkspaceDocument(replica, { documentId: NOTE }),
    )

    await applyWorkspaceDocumentUpdate(deps(store, blobs), { workspaceId: WS, update })

    // One row: the child rides its parent's bytes, as a restore brings it back.
    expect(readTrashEntries(store.get()).map((row) => row.documentId)).toEqual([NOTE])
    const restored = await restoredFrom(blobs, NOTE, store)
    expect(restored && readWorkspaceDocuments(restored).map((each) => each.documentId)).toEqual([
      NOTE,
      CHILD,
    ])
    expect(
      restored && documentContainers(restored, NOTE).getText(MARKDOWN_BODY_KEY).toString(),
    ).toBe('# kept words')
  })

  it('gives each document under a removed folder its own row', async () => {
    const store = new StoredDoc(seed())
    const blobs = new FakeBlobStore()
    const update = updateFrom(store, (replica) => deleteWorkspaceNodeAtPath(replica, 'folder'))

    await applyWorkspaceDocumentUpdate(deps(store, blobs), { workspaceId: WS, update })

    expect(readTrashEntries(store.get()).map((row) => row.documentId)).toEqual([OTHER])
  })

  it('keeps nothing of the update when the bytes cannot be stored', async () => {
    const store = new StoredDoc(seed())
    const refusing = new (class extends FakeBlobStore {
      override async put(): Promise<never> {
        throw new Error('disk full')
      }
    })()
    const update = updateFrom(store, (replica) =>
      deleteWorkspaceDocument(replica, { documentId: OTHER }),
    )

    await expect(
      applyWorkspaceDocumentUpdate(deps(store, refusing), { workspaceId: WS, update }),
    ).rejects.toThrow('disk full')

    expect(store.saves).toBe(0)
    expect(readWorkspaceDocuments(store.get()).map((each) => each.documentId)).toContain(OTHER)
  })

  it('stores nothing for an update that only edits content', async () => {
    const store = new StoredDoc(seed())
    const blobs = new FakeBlobStore()
    const update = updateFrom(store, (replica) =>
      documentContainers(replica, OTHER).getText(MARKDOWN_BODY_KEY).insert(0, 'x'),
    )

    await applyWorkspaceDocumentUpdate(deps(store, blobs), { workspaceId: WS, update })

    expect(blobs.held.size).toBe(0)
    expect(readTrashEntries(store.get())).toEqual([])
  })
})
