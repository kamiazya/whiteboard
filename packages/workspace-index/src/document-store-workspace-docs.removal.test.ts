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
import { describe, expect, it } from 'vitest'
import {
  type DocumentStoreWorkspaceDocsOptions,
  RecordStoreWorkspaceDocs,
} from './document-store-workspace-docs.js'
import { RECORD_SUBJECTS } from './test-utils/record-subjects.js'

const WORKSPACE = '01NZKY725TZFCN2YEYKGKE55D5'
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

describe.each(RECORD_SUBJECTS)('a save racing a delete, record held as $name', (subject) => {
  const docsOver = (store: DocumentStore, options?: DocumentStoreWorkspaceDocsOptions) =>
    new RecordStoreWorkspaceDocs(store, subject.kind, options)

  async function seededEdit(docs: ReturnType<typeof docsOver>): Promise<unknown> {
    const doc = await subject.fresh()
    subject.put(doc, 't', 'first')
    await docs.save(WORKSPACE, doc)
    subject.put(doc, 'edit', 'and an edit')
    return doc
  }

  it('a save racing a delete writes nothing once the keeper refuses the mint', async () => {
    const inner = new InMemoryDocumentStore()
    const paused = pausedAtAppend(inner)
    const removed = new Set<string>()
    const refusal = new Error('workspace removed')
    const docs = docsOver(paused.store, {
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
    const docs = docsOver(paused.store)
    const doc = await seededEdit(docs)

    const saving = docs.save(WORKSPACE, doc)
    await paused.reached
    await inner.deleteDoc({ docRef: REF })
    paused.release()

    expect(await saving).not.toBeNull()
    const reopened = (await docs.open(WORKSPACE))!
    expect(subject.entries(reopened)).toEqual({ t: 'first', edit: 'and an edit' })
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
    const docs = docsOver(inner)
    const pulled = await subject.fresh()
    subject.put(pulled, 't', 'pulled again')

    await docs.save(WORKSPACE, pulled)

    expect(subject.entries((await docs.open(WORKSPACE))!)).toEqual({ t: 'pulled again' })
  })
})
