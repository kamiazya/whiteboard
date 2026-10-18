/**
 * The workspace record carries more than its documents: what is in the trash
 * and what is pinned are the workspace's own, and the routes that change them
 * ask for `workspace:write`. A workspace-document update from a caller who may
 * only edit what documents say must not reach either by writing the record
 * directly.
 */
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  documentContainers,
  forgetTrashEntry,
  MARKDOWN_BODY_KEY,
  readPinnedDocumentIds,
  readTrashEntries,
  recordTrashEntry,
  setWorkspacePinned,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'

const WS = 'ws-1'
const KEPT = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const TRASHED = '01BRWAAAAAAAAAAAAAAAAAAAA6'
const BLOB = { algorithm: 'sha-256', digestHex: 'a'.repeat(64) } as const

/** A workspace holding one document, pinned, and one in the trash. */
function seed(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'kept', documentId: KEPT, kind: 'markdown' })
  setWorkspacePinned(doc, KEPT, true)
  recordTrashEntry(doc, { documentId: TRASHED, path: 'gone', deletedAt: 1_000, blob: BLOB })
  return doc
}

function deps(store: StoredDoc) {
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
  return { workspaceDocuments, liveDocuments }
}

function updateFrom(store: StoredDoc, edit: (replica: LoroDoc) => void): Uint8Array {
  const replica = store.get().fork()
  const from = replica.oplogVersion()
  edit(replica)
  replica.commit()
  return replica.export({ mode: 'update', from })
}

const applyWithoutPlacing = (store: StoredDoc, update: Uint8Array) =>
  applyWorkspaceDocumentUpdate(deps(store), { workspaceId: WS, update, mayPlaceDocuments: false })

describe('a workspace-document update from a caller who may not place documents', () => {
  it('cannot purge a trash entry', async () => {
    const store = new StoredDoc(seed())
    const update = updateFrom(store, (replica) => forgetTrashEntry(replica, TRASHED))

    expect(await applyWithoutPlacing(store, update)).toEqual({ kind: 'placement-refused' })

    expect(store.saves).toBe(0)
    expect(readTrashEntries(store.get()).map((entry) => entry.documentId)).toEqual([TRASHED])
  })

  it('cannot rewrite a trash entry', async () => {
    const store = new StoredDoc(seed())
    const update = updateFrom(store, (replica) =>
      recordTrashEntry(replica, {
        documentId: TRASHED,
        path: 'elsewhere',
        deletedAt: 2_000,
        blob: BLOB,
      }),
    )

    expect(await applyWithoutPlacing(store, update)).toEqual({ kind: 'placement-refused' })

    expect(readTrashEntries(store.get())).toMatchObject([{ path: 'gone' }])
  })

  it('cannot change the pinned list', async () => {
    const store = new StoredDoc(seed())
    const update = updateFrom(store, (replica) => setWorkspacePinned(replica, KEPT, false))

    expect(await applyWithoutPlacing(store, update)).toEqual({ kind: 'placement-refused' })

    expect(store.saves).toBe(0)
    expect(readPinnedDocumentIds(store.get())).toEqual([KEPT])
  })

  it('cannot add a root of its own beside the tree', async () => {
    const store = new StoredDoc(seed())
    const update = updateFrom(store, (replica) => replica.getMap('junk').set('k', 'v'))

    expect(await applyWithoutPlacing(store, update)).toEqual({ kind: 'placement-refused' })
  })

  // A root that shares the tree's name reads `['tree', …]` by path, the same
  // first segment a document's content has.
  it.each([
    ['map', (replica: LoroDoc) => replica.getMap('tree').set('x', 1)],
    ['text', (replica: LoroDoc) => replica.getText('tree').insert(0, 'x')],
    ['list', (replica: LoroDoc) => replica.getList('tree').insert(0, 'x')],
    ['counter', (replica: LoroDoc) => replica.getCounter('tree').increment(1)],
  ] as const)('cannot write a %s root named like the tree', async (_kind, edit) => {
    const store = new StoredDoc(seed())
    const update = updateFrom(store, edit)

    expect(await applyWithoutPlacing(store, update)).toEqual({ kind: 'placement-refused' })

    expect(store.saves).toBe(0)
  })

  it('still edits what a document says', async () => {
    const store = new StoredDoc(seed())
    const update = updateFrom(store, (replica) =>
      documentContainers(replica, KEPT).getText(MARKDOWN_BODY_KEY).insert(0, 'hello'),
    )

    expect(await applyWithoutPlacing(store, update)).toMatchObject({ kind: 'applied' })
    expect(store.saves).toBe(1)
  })

  it('still answers a delete with the same refusal it always did', async () => {
    const store = new StoredDoc(seed())
    const update = updateFrom(store, (replica) =>
      deleteWorkspaceDocument(replica, { documentId: KEPT }),
    )

    expect(await applyWithoutPlacing(store, update)).toEqual({ kind: 'placement-refused' })
  })
})
