import { Loro } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { duplicateBrowserDocument } from './duplicate-browser-document.js'
import { listLocalDocuments } from './local-document-summary.js'

function realSnapshotWithElements(elements: readonly unknown[]): Uint8Array {
  const doc = new Loro()
  const list = doc.getList('elements')
  for (const el of elements) list.push(el)
  return doc.export({ mode: 'snapshot' })
}

function bytesFor(store: LocalStoreDouble, documentId: string): Uint8Array | undefined {
  // The double records every save in order; the LAST one for an id is what a
  // reader would load.
  return store.loro.saved.filter((row) => row.id === documentId).at(-1)?.bytes
}

/**
 * The browser keeper's duplicate, addressed by PATH — what an index row has,
 * as against the document page, which already holds the open document.
 */
describe('duplicating a browser-kept document by its path', () => {
  it('copies the content and gives the copy its own path and a derived name', async () => {
    const store = new LocalStoreDouble()
    const source = await store.index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/roadmap',
      kind: 'markdown',
      name: 'Roadmap',
    })
    await store.loro.save(source.documentId, realSnapshotWithElements([{ id: 'rect-1' }]))

    const copy = await duplicateBrowserDocument({
      index: store.index,
      loro: store.loro,
      clock: store.clock,
      sourcePath: 'notes/roadmap',
    })

    expect(copy.documentId).not.toBe(source.documentId)
    // The kind travels: a duplicated note is a note, not a board.
    expect(copy.kind).toBe('markdown')
    expect(copy.name).toBe('Roadmap (copy)')
    const rows = await listLocalDocuments(store.index, store.clock)
    expect(rows.map((row) => row.path).sort()).toEqual(['notes/roadmap', copy.path].sort())
    expect(copy.path).not.toBe('notes/roadmap')
    // A deep copy: the bytes are the source's content, not an empty document.
    expect(bytesFor(store, copy.documentId)).toEqual(bytesFor(store, source.documentId))
  })

  it('refuses a path the workspace does not hold rather than copying an empty document', async () => {
    const store = new LocalStoreDouble()
    await expect(
      duplicateBrowserDocument({
        index: store.index,
        loro: store.loro,
        clock: store.clock,
        sourcePath: 'notes/gone',
      }),
    ).rejects.toThrow(/notes\/gone/)
  })
})
