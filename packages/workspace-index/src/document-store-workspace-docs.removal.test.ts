/**
 * A save in flight across a delete of the record it read.
 *
 * `save` reads the manifest and the frontier, then appends — four store calls,
 * so a delete can commit between the read that found the record and the
 * append that extends it. The append must not bring the record back as a
 * log with nothing behind it: that fragment opens as nothing, cannot be
 * listed, and was written past the keeper's `beforeMint` answer.
 */
import type { DocRef, DocumentStore } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { DocumentStoreWorkspaceDocs } from './document-store-workspace-docs.js'

const WORKSPACE = 'ws-removed-mid-save'
const REF: DocRef = { kind: 'workspace-tree', workspaceId: WORKSPACE }

/** The store, with `appendDeltas` held until `release` — the window to delete in. */
function pausedAtAppend(inner: DocumentStore): {
  store: DocumentStore
  reached: Promise<void>
  release: () => void
} {
  let release = (): void => {}
  let reach = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  const store: DocumentStore = {
    loadSnapshot: (input) => inner.loadSnapshot(input),
    readSnapshotManifest: (input) => inner.readSnapshotManifest(input),
    saveSnapshot: (input) => inner.saveSnapshot(input),
    saveCompactedSnapshot: (input) => inner.saveCompactedSnapshot(input),
    loadDeltas: (input) => inner.loadDeltas(input),
    readFrontier: (input) => inner.readFrontier(input),
    deleteDoc: (input) => inner.deleteDoc(input),
    appendDeltas: async (input) => {
      reach()
      await gate
      return inner.appendDeltas(input)
    },
  }
  return { store, reached, release }
}

async function seededEdit(docs: DocumentStoreWorkspaceDocs): Promise<LoroDoc> {
  const doc = new LoroDoc()
  doc.getText('t').insert(0, 'first')
  await docs.save(WORKSPACE, doc)
  doc.getText('t').insert(5, ' and an edit')
  return doc
}

it('a save racing a delete writes nothing once the keeper refuses the mint', async () => {
  const inner = new InMemoryDocumentStore()
  const paused = pausedAtAppend(inner)
  const removed = new Set<string>()
  const refusal = new Error('workspace removed')
  const docs = new DocumentStoreWorkspaceDocs(paused.store, {
    beforeMint: async (id) => {
      if (removed.has(id)) throw refusal
    },
  })
  const doc = await seededEdit(docs)

  const saving = docs.save(WORKSPACE, doc)
  await paused.reached
  removed.add(WORKSPACE)
  await inner.deleteDoc({ docRef: REF })
  paused.release()

  await expect(saving).rejects.toBe(refusal)
  expect((await inner.loadDeltas({ docRef: REF, afterSeq: null })).updates).toEqual([])
  expect(await inner.readFrontier({ docRef: REF })).toBeNull()
  expect(await inner.readSnapshotManifest({ docRef: REF })).toBeNull()
})

it('a save racing a delete of an id still held mints the record again, whole', async () => {
  const inner = new InMemoryDocumentStore()
  const paused = pausedAtAppend(inner)
  const docs = new DocumentStoreWorkspaceDocs(paused.store)
  const doc = await seededEdit(docs)

  const saving = docs.save(WORKSPACE, doc)
  await paused.reached
  await inner.deleteDoc({ docRef: REF })
  paused.release()

  expect(await saving).not.toBeNull()
  expect((await docs.open(WORKSPACE))?.getText('t').toString()).toBe('first and an edit')
})

it('a mint over a log with nothing behind it reads back what it minted', async () => {
  const inner = new InMemoryDocumentStore()
  // What a write racing a delete used to leave: a delta no snapshot stands
  // behind, and not a CRDT update this document can import.
  await inner.appendDeltas({
    docRef: REF,
    deltaBatch: { updates: [new Uint8Array([1, 2, 3])], newFrontier: new Uint8Array([1]) },
    requireSnapshot: false,
  })
  const docs = new DocumentStoreWorkspaceDocs(inner)
  const pulled = new LoroDoc()
  pulled.getText('t').insert(0, 'pulled again')

  await docs.save(WORKSPACE, pulled)

  expect((await docs.open(WORKSPACE))?.getText('t').toString()).toBe('pulled again')
})
