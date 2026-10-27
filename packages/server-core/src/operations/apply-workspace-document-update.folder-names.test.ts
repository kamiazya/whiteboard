/**
 * What a workspace-document sync update may do with a FOLDER's display name:
 * the names every other folder-name writer refuses — blank, holding a "/",
 * past the display-name bound — are refused here too, or a client could
 * store through sync what no other surface can write back. A name already
 * stored, or the same write's own repair of one, is let through.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readWorkspaceFolderNames,
  readWorkspaceNodes,
  WORKSPACE_TREE_KEY,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_NAME_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedBlobStore } from '../test-utils/unused-blob-store.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { FolderNameRefusedError, syncWriteAnswer } from './sync-write-refusals.js'

const WS = 'ws-1'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

function seed(edit?: (doc: LoroDoc) => void): StoredDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'week/notes', documentId: DOC_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, DOC_ID), 'body')
  edit?.(doc)
  doc.commit()
  return new StoredDoc(doc)
}

function workspaceDeps(store: StoredDoc) {
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
  return { liveDocuments, workspaceDocuments, blobStore: unusedBlobStore() }
}

function send(store: StoredDoc, edit: (doc: LoroDoc) => void) {
  const client = store.get().fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return applyWorkspaceDocumentUpdate(workspaceDeps(store), {
    workspaceId: WS,
    update: client.export({ mode: 'update', from }),
  }).catch((err: unknown) => err)
}

/** Writes `name` straight onto the folder node at `path`, as a raw client would. */
function nameFolder(doc: LoroDoc, path: string, name: string): void {
  const node = doc
    .getTree(WORKSPACE_TREE_KEY)
    .getNodes()
    .find(
      (candidate) =>
        candidate.data.get('segment') === path && candidate.data.get('documentId') === undefined,
    )
  if (node === undefined) throw new Error(`no folder ${path}`)
  node.data.set('name', name)
}

const storedNames = (store: StoredDoc) => {
  store.evict()
  return readWorkspaceFolderNames(store.get())
}

describe('a workspace-document sync update that names a folder', () => {
  it('a folder name is applied', async () => {
    const store = seed()

    await expect(send(store, (doc) => nameFolder(doc, 'week', 'Week 6'))).resolves.toMatchObject({
      kind: 'applied',
    })
    expect(storedNames(store)).toEqual([{ path: 'week', name: 'Week 6' }])
  })

  it.each([
    ['holding a "/"', 'a/b'],
    ['blank', '   '],
    ['past the display-name bound', 'x'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1)],
  ])('a folder name %s is refused, and nothing is kept', async (_label, name) => {
    const store = seed()

    const refusal = await send(store, (doc) => nameFolder(doc, 'week', name))

    expect(refusal).toBeInstanceOf(FolderNameRefusedError)
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'folder_name_refused', status: 400 })
    expect(store.saves).toBe(0)
    expect(storedNames(store)).toEqual([])
  })

  it('a refused name already stored does not refuse an unrelated edit', async () => {
    const store = seed((doc) => nameFolder(doc, 'week', 'a/b'))

    // A document rename writes node meta, so the placement judge reads the tree.
    const renameNote = (doc: LoroDoc) =>
      doc
        .getTree(WORKSPACE_TREE_KEY)
        .getNodes()
        .find((node) => node.data.get('documentId') === DOC_ID)
        ?.data.set('name', 'Notes')
    await expect(send(store, renameNote)).resolves.toMatchObject({ kind: 'applied' })
    const note = readWorkspaceNodes(store.get()).find((node) => node.path === 'week/notes')
    expect(note?.type === 'document' && note.meta.name).toBe('Notes')
  })

  it('repairing a refused name already stored is applied', async () => {
    const store = seed((doc) => nameFolder(doc, 'week', 'a/b'))

    await expect(send(store, (doc) => nameFolder(doc, 'week', 'Week 6'))).resolves.toMatchObject({
      kind: 'applied',
    })
    expect(storedNames(store)).toEqual([{ path: 'week', name: 'Week 6' }])
  })
})
