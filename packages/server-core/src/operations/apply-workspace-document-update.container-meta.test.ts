/**
 * A tree node's meta key held as a CONTAINER rather than a value.
 *
 * An edit inside such a container lands one level below the node's own map,
 * where a content edit lands too — so a judge that recognised meta writes by
 * the map alone let a caller entitled to edit content alone rename, blank or
 * re-place a document through it. A container at a meta key is therefore
 * unreadable, and an operation inside one is a meta and placement write.
 */
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc, LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedBlobStore } from '../test-utils/unused-blob-store.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { UnreadableDocumentMetaError } from './sync-write-refusals.js'

const WS = 'ws-1'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const PATH = 'notes'

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

function updateFrom(base: LoroDoc, edit: (doc: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

function nodeData(doc: LoroDoc) {
  const node = doc
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === DOC_ID)
  if (node === undefined) throw new Error(`no node holds ${DOC_ID}`)
  return node.data
}

/** The meta key's container, as a skewed client finds it. */
function metaText(doc: LoroDoc, key: string): LoroText {
  const held = nodeData(doc).get(key)
  if (!(held instanceof LoroText)) throw new Error(`${key} is not a text container`)
  return held
}

const seed = () => {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: PATH,
    documentId: DOC_ID,
    kind: 'markdown',
    name: 'Notes',
  })
  return doc
}

/** A record already holding `key` as a text container, written before any keeper refused one. */
function seededWithContainer(key: string, text: string): StoredDoc {
  const doc = seed()
  nodeData(doc).setContainer(key, new LoroText()).insert(0, text)
  doc.commit()
  return new StoredDoc(doc)
}

const send = (store: StoredDoc, edit: (doc: LoroDoc) => void, mayPlaceDocuments: boolean) =>
  applyWorkspaceDocumentUpdate(deps(store), {
    workspaceId: WS,
    update: updateFrom(store.get(), edit),
    mayPlaceDocuments,
  })

const listed = (store: StoredDoc) =>
  readWorkspaceDocuments(store.get()).map(({ path, name }) => ({ path, name }))

describe('a workspace-document update holding a node meta key as a container', () => {
  it.each([
    ['name', 'Notes', false],
    ['segment', PATH, true],
  ])('making %s a container is refused, whatever it reads as', async (key, text, mayPlace) => {
    const store = new StoredDoc(seed())

    const refusal = await send(
      store,
      (doc) => nodeData(doc).setContainer(key, new LoroText()).insert(0, text),
      mayPlace,
    ).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(UnreadableDocumentMetaError)
    expect(store.saves).toBe(0)
    expect(listed(store)).toEqual([{ path: PATH, name: 'Notes' }])
  })

  it('a content-only caller blanking a name held as a container is refused', async () => {
    const store = seededWithContainer('name', 'Notes')

    const result = await send(
      store,
      (doc) => metaText(doc, 'name').delete(0, 'Notes'.length),
      false,
    ).catch((err: unknown) => err)

    expect(result).toEqual({ kind: 'placement-refused' })
    expect(store.saves).toBe(0)
    expect(metaText(store.get(), 'name').toString()).toBe('Notes')
  })

  it('a content-only caller text-editing a segment held as a container is refused', async () => {
    const store = seededWithContainer('segment', 'a')

    const result = await send(
      store,
      (doc) => metaText(doc, 'segment').insert(1, '/..'),
      false,
    ).catch((err: unknown) => err)

    expect(result).toEqual({ kind: 'placement-refused' })
    expect(store.saves).toBe(0)
    expect(metaText(store.get(), 'segment').toString()).toBe('a')
  })
})
