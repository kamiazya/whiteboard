/**
 * A document node's content keys hold one container each, of the kind the
 * bridge declares (`CONTENT_CONTAINER_KEYS`). Every reader and writer opens
 * the container at its key, and opening one over a scalar or over a container
 * of another kind throws or hands back the wrong container — so an update
 * leaving either there makes the document unreadable to everything after it.
 * It is refused whoever sends it: such a key is no organisation change, so a
 * content-only caller would otherwise be let through.
 */
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc, LoroMap, type LoroTreeNode } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedBlobStore } from '../test-utils/unused-blob-store.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { SyncWriteRefusalError } from './sync-write-refusals.js'

const WS = 'ws-1'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

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
  return { liveDocuments, workspaceDocuments, blobStore: unusedBlobStore() }
}

function nodeData(doc: LoroDoc): LoroTreeNode['data'] {
  const node = doc
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === DOC_ID)
  if (node === undefined) throw new Error(`no node holds ${DOC_ID}`)
  return node.data
}

function seed(): StoredDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
  doc.commit()
  return new StoredDoc(doc)
}

function updateFrom(base: LoroDoc, edit: (data: LoroTreeNode['data']) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(nodeData(client))
  client.commit()
  return client.export({ mode: 'update', from })
}

const SHAPES: ReadonlyArray<readonly [string, (data: LoroTreeNode['data']) => void]> = [
  ['a scalar at nodes', (data) => data.set('nodes', 1)],
  ['a map at body', (data) => data.setContainer('body', new LoroMap())],
  ['nodes deleted', (data) => data.delete('nodes')],
]

describe('a workspace-document update leaving a content key holding the wrong kind', () => {
  it.each(SHAPES)('%s is refused for a content-only caller', async (_shape, edit) => {
    const store = seed()

    const refusal = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update: updateFrom(store.get(), edit),
      mayPlaceDocuments: false,
    }).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(SyncWriteRefusalError)
    expect(refusal).toMatchObject({ code: 'invalid_document_root', status: 400 })
    expect(store.saves).toBe(0)
    expect(nodeData(store.get()).get('nodes')).toBeInstanceOf(LoroMap)
  })

  it('a content edit inside the declared container still lands', async () => {
    const store = seed()

    const result = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update: updateFrom(store.get(), (data) =>
        (data.get('nodes') as LoroMap).set('n1', { id: 'n1' }),
      ),
      mayPlaceDocuments: false,
    })

    expect(result.kind).toBe('applied')
    expect(store.saves).toBe(1)
  })
})
