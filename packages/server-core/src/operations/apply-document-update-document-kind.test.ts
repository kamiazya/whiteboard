/**
 * A document's own update is saved onto its workspace node, so its envelope
 * kind is held to the kind the node records, as a workspace update's is: a
 * board's update cannot make it read as a note.
 */
import { readDocumentKind, writeDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'

function liveDeps(store: StoredDoc, recorded: DocumentKind | null) {
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
    get: async () => store.get(),
    kind: async () => recorded,
    save: async (_workspaceId, _path, doc) => store.save(doc),
    evict: () => store.evict(),
  }
  return { liveDocuments }
}

function updateFrom(base: LoroDoc, edit: (doc: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

function board(envelope: DocumentKind | null): StoredDoc {
  const doc = new LoroDoc()
  doc.getMap('nodes').set('n1', { id: 'n1', type: 'text', text: 'keep me' })
  if (envelope !== null) writeDocumentKind(doc, envelope)
  doc.commit()
  return new StoredDoc(doc)
}

const apply = (store: StoredDoc, recorded: DocumentKind | null, update: Uint8Array) =>
  applyDocumentUpdate(liveDeps(store, recorded), { workspaceId: 'ws-1', path: 'board', update })

describe('a per-document sync update writing its envelope kind', () => {
  it.each([
    ['kinded', 'spatial'],
    ['unkinded', null],
  ] as const)('%s, rewritten against the recorded kind, is refused', async (_shape, envelope) => {
    const store = board(envelope)
    const update = updateFrom(store.get(), (doc) => writeDocumentKind(doc, 'markdown'))

    const refusal = await apply(store, 'spatial', update).catch((err: unknown) => err)

    expect(refusal).toMatchObject({ code: 'document_kind_changed', status: 400 })
    expect(store.saves).toBe(0)
    expect(readDocumentKind(store.get())).toBe(envelope ?? undefined)
  })

  it('claiming an unkinded document as its recorded kind lands', async () => {
    const store = board(null)
    const update = updateFrom(store.get(), (doc) => writeDocumentKind(doc, 'spatial'))

    await apply(store, 'spatial', update)

    expect(store.saves).toBe(1)
    expect(readDocumentKind(store.get())).toBe('spatial')
  })

  it('a document no path records yet takes whatever kind it is created with', async () => {
    const store = new StoredDoc(new LoroDoc())
    const update = updateFrom(store.get(), (doc) => writeDocumentKind(doc, 'markdown'))

    await apply(store, null, update)

    expect(store.saves).toBe(1)
  })
})
