/**
 * A `__proto__` key comes back from every JSON projection of a record as the
 * object's prototype, so a member who may write content could plant one that
 * lends a document keys it does not hold. Both sync paths refuse it, with
 * nothing kept.
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
import { applyDocumentUpdate } from './apply-document-update.js'
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

describe('a sync update writing a `__proto__` key', () => {
  it('is refused on the per-document path, keeping nothing', async () => {
    const doc = new LoroDoc()
    doc.getMap('nodes').set('n1', { id: 'n1', text: 'keep me' })
    doc.commit()
    const store = new StoredDoc(doc)
    const liveDocuments: LiveDocuments = {
      ...unusedLiveDocuments(),
      withWriteLock: (_workspaceId, fn) => fn(),
      get: async () => store.get(),
      kind: async () => 'spatial',
      save: async (_workspaceId, _path, saved) => store.save(saved),
      evict: () => store.evict(),
    }
    const update = updateFrom(store.get(), (client) =>
      client.getMap('nodes').set('__proto__', { id: 'n2' }),
    )

    const refusal = await applyDocumentUpdate(
      { liveDocuments },
      { workspaceId: WS, path: 'board', update },
    ).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(SyncWriteRefusalError)
    expect(refusal).toMatchObject({ code: 'reserved_map_key', status: 400 })
    expect(store.saves).toBe(0)
    expect(store.get().getMap('nodes').keys()).toEqual(['n1'])
  })

  it('is refused on the workspace-document path, keeping nothing', async () => {
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
    const update = updateFrom(store.get(), (client) =>
      documentContainers(client, BOARD).getMap('nodes').set('__proto__', { id: 'n2' }),
    )

    const refusal = await applyWorkspaceDocumentUpdate(
      { liveDocuments, workspaceDocuments, blobStore: unusedBlobStore() },
      { workspaceId: WS, update, mayPlaceDocuments: false },
    ).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(SyncWriteRefusalError)
    expect(refusal).toMatchObject({ code: 'reserved_map_key', status: 400 })
    expect(store.saves).toBe(0)
    expect(documentContainers(store.get(), BOARD).getMap('nodes').size).toBe(0)
  })
})
