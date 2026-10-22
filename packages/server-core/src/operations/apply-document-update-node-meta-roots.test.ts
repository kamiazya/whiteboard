/**
 * A document's update is saved onto its workspace node's own map, beside the
 * node's meta, so an update adding a root no node can take as content is
 * refused at the sync surface rather than skipped where the save lands —
 * skipped, the client would believe a write that never reached the record.
 */
import { readMarkdownBody, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'

function liveDeps(store: StoredDoc) {
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    kind: async () => null,
    withWriteLock: (_workspaceId, fn) => fn(),
    get: async () => store.get(),
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

function seed(edit: (doc: LoroDoc) => void = () => {}): LoroDoc {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, 'short')
  edit(doc)
  doc.commit()
  return doc
}

const apply = (store: StoredDoc, update: Uint8Array) =>
  applyDocumentUpdate(liveDeps(store), { workspaceId: 'ws-1', path: 'notes', update })

describe('a per-document sync update', () => {
  it('adding a root named after node meta is refused and nothing is kept', async () => {
    const store = new StoredDoc(seed())
    const update = updateFrom(store.get(), (doc) => doc.getMap('nameChosen').set('x', 1))

    const refusal = await apply(store, update).catch((err: unknown) => err)

    expect(refusal).toMatchObject({
      name: 'RootNoDocumentHoldsError',
      code: 'invalid_document_root',
      status: 400,
      roots: ['nameChosen'],
    })
    expect(store.saves).toBe(0)
    expect(store.evictions).toBe(1)
    expect(Object.keys(store.get().getShallowValue())).not.toContain('nameChosen')
  })

  it('adding a content container of another kind is refused', async () => {
    const store = new StoredDoc(seed())
    const update = updateFrom(store.get(), (doc) => doc.getMap('body').set('x', 1))

    await expect(apply(store, update)).rejects.toMatchObject({ roots: ['body'] })
    expect(store.saves).toBe(0)
  })

  it('to a document already holding such a root still takes an edit that adds none', async () => {
    const store = new StoredDoc(seed((doc) => doc.getText('name').insert(0, 'stray')))
    const update = updateFrom(store.get(), (doc) => doc.getText('body').insert(0, 'a '))

    await apply(store, update)

    expect(store.saves).toBe(1)
    expect(readMarkdownBody(store.get())).toBe('a short')
  })
})
