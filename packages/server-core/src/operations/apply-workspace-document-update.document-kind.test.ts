/**
 * A document's kind is recorded twice: on its workspace node, which is
 * placement, and in its envelope, which travels with its content. Most
 * readers let the envelope win, so an update rewriting it would make a board
 * read as a note — to an agent, to search, to render — and disarm the guard
 * that stops a markdown write from replacing a board's nodes. The envelope
 * may only ever say what the node says; giving an unkinded document the
 * node's kind is how a keeper claims it, and stays allowed.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readDocumentKind,
  writeDocumentKind,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { LoroDoc, LoroMap } from 'loro-crdt'
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
const FRESH = '01BRWAAAAAAAAAAAAAAAAAAAF0'

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

/** A workspace holding one spatial board, its envelope kinded or not. */
function seed(envelope: DocumentKind | null): StoredDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: BOARD, kind: 'spatial' })
  const board = documentContainers(doc, BOARD)
  board.getMap('nodes').set('n1', { id: 'n1', type: 'text', text: 'keep me' })
  if (envelope !== null) writeDocumentKind(board, envelope)
  doc.commit()
  return new StoredDoc(doc)
}

function updateFrom(base: LoroDoc, edit: (client: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

const envelopeOf = (doc: LoroDoc) => documentContainers(doc, BOARD).getMap('document')

const REWRITES: ReadonlyArray<readonly [string, DocumentKind | null, (client: LoroDoc) => void]> = [
  [
    'a set envelope kind rewritten',
    'spatial',
    (client) => writeDocumentKind(documentContainers(client, BOARD), 'markdown'),
  ],
  [
    'an unkinded envelope given another kind than its node',
    null,
    (client) => writeDocumentKind(documentContainers(client, BOARD), 'markdown'),
  ],
  ['a set envelope kind deleted', 'spatial', (client) => envelopeOf(client).delete('kind')],
  [
    'an envelope kind set to a value no kind parses as',
    'spatial',
    (client) => envelopeOf(client).set('kind', 'sheet'),
  ],
]

describe('a workspace-document update writing a document envelope kind', () => {
  it.each(REWRITES)('%s is refused, keeping nothing', async (_shape, envelope, edit) => {
    const store = seed(envelope)

    const refusal = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update: updateFrom(store.get(), edit),
      mayPlaceDocuments: false,
    }).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(SyncWriteRefusalError)
    expect(refusal).toMatchObject({ code: 'document_kind_changed', status: 400 })
    expect(store.saves).toBe(0)
    expect(readDocumentKind(documentContainers(store.get(), BOARD))).toBe(envelope ?? undefined)
  })

  it('is refused for a caller who may also place documents', async () => {
    const store = seed('spatial')

    const refusal = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update: updateFrom(store.get(), (client) =>
        writeDocumentKind(documentContainers(client, BOARD), 'markdown'),
      ),
    }).catch((err: unknown) => err)

    expect(refusal).toMatchObject({ code: 'document_kind_changed' })
    expect(store.saves).toBe(0)
  })

  it('is refused when the envelope is replaced by a new map of another kind', async () => {
    const store = seed('spatial')
    const update = updateFrom(store.get(), (client) => {
      const node = client
        .getTree('tree')
        .getNodes()
        .find((each) => each.data.get('documentId') === BOARD)
      node?.data.setContainer('document', new LoroMap()).set('kind', 'markdown')
    })

    const refusal = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update,
      mayPlaceDocuments: false,
    }).catch((err: unknown) => err)

    expect(refusal).toMatchObject({ code: 'document_kind_changed' })
    expect(store.saves).toBe(0)
  })

  it("is refused when an existing node's own kind is rewritten under a kinded envelope", async () => {
    const store = seed('spatial')
    const update = updateFrom(store.get(), (client) => {
      const node = client
        .getTree('tree')
        .getNodes()
        .find((each) => each.data.get('documentId') === BOARD)
      node?.data.set('kind', 'markdown')
    })

    const refusal = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update,
    }).catch((err: unknown) => err)

    expect(refusal).toMatchObject({ code: 'document_kind_changed' })
    expect(store.saves).toBe(0)
  })

  it("refuses a node's own kind rewritten under an unkinded envelope as placement", async () => {
    const store = seed(null)
    const update = updateFrom(store.get(), (client) => {
      const node = client
        .getTree('tree')
        .getNodes()
        .find((each) => each.data.get('documentId') === BOARD)
      node?.data.set('kind', 'markdown')
    })

    const result = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update,
      mayPlaceDocuments: false,
    })

    expect(result.kind).toBe('placement-refused')
    expect(store.saves).toBe(0)
  })

  it("claims an unkinded document as its node's kind", async () => {
    const store = seed(null)

    const result = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update: updateFrom(store.get(), (client) =>
        writeDocumentKind(documentContainers(client, BOARD), 'spatial'),
      ),
      mayPlaceDocuments: false,
    })

    expect(result.kind).toBe('applied')
    expect(readDocumentKind(documentContainers(store.get(), BOARD))).toBe('spatial')
  })

  it('takes an ordinary content edit of a kinded board', async () => {
    const store = seed('spatial')

    const result = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update: updateFrom(store.get(), (client) =>
        documentContainers(client, BOARD).getMap('nodes').set('n2', { id: 'n2' }),
      ),
      mayPlaceDocuments: false,
    })

    expect(result.kind).toBe('applied')
    expect(store.saves).toBe(1)
  })

  it('takes a new document whose envelope says what its node says', async () => {
    const store = seed('spatial')

    const result = await applyWorkspaceDocumentUpdate(deps(store), {
      workspaceId: WS,
      update: updateFrom(store.get(), (client) => {
        createWorkspaceDocumentAtPath(client, {
          path: 'fresh',
          documentId: FRESH,
          kind: 'markdown',
        })
        writeDocumentKind(documentContainers(client, FRESH), 'markdown')
      }),
    })

    expect(result.kind).toBe('applied')
  })
})
