/**
 * A shape an older version stored and no reader serves any more would be kept
 * by the daemon and then refused by every reader. The sync path refuses the
 * write by name, with nothing kept and the cached record dropped.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedBlobStore } from '../test-utils/unused-blob-store.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { SyncWriteRefusalError } from './sync-write-refusals.js'

const WS = 'ws-1'
const BOARD = '01BRWAAAAAAAAAAAAAAAAAAAB0'

function updateFrom(base: LoroDoc, edit: (client: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

async function apply(edit: (client: LoroDoc) => void) {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: BOARD, kind: 'spatial' })
  doc.commit()
  const store = new StoredDoc(doc)
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    get: async () => store.get(),
    save: async (_workspaceId, saved) => store.save(saved),
    evict: () => store.evict(),
    evictProjections: () => {},
  }
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
  }
  const update = updateFrom(store.get(), edit)
  const refusal = await applyWorkspaceDocumentUpdate(
    { liveDocuments, workspaceDocuments, blobStore: unusedBlobStore() },
    { workspaceId: WS, update, mayPlaceDocuments: false },
  ).catch((err: unknown) => err)
  return { refusal, store }
}

describe('a sync update writing a retired stored shape', () => {
  it.each([
    [
      'a node under x-whiteboard',
      (client: LoroDoc) =>
        documentContainers(client, BOARD)
          .getMap('nodes')
          .set('n2', { id: 'n2', 'x-whiteboard': {} }),
      'retired_stored_shape',
    ],
    [
      'a row in the flat comments plane',
      (client: LoroDoc) =>
        documentContainers(client, BOARD).getMap('comments').set('c1', { id: 'c1' }),
      'retired_comment_plane',
    ],
  ])('is refused, keeping nothing, for %s', async (_what, edit, code) => {
    const { refusal, store } = await apply(edit)

    expect(refusal).toBeInstanceOf(SyncWriteRefusalError)
    expect(refusal).toMatchObject({ code, status: 400 })
    expect(store.saves).toBe(0)
    expect(store.evictions).toBe(1)
    const next = documentContainers(store.get(), BOARD)
    expect(next.getMap('nodes').size).toBe(0)
    expect(next.getMap('comments').size).toBe(0)
  })
})
