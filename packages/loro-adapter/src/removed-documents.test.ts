import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { documentsRemovedSince } from './removed-documents.js'
import {
  createWorkspaceDocument,
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  documentContainers,
  ensureFolderPath,
  importWorkspaceSubtree,
  moveWorkspaceDocument,
  moveWorkspaceNodeToPath,
  readWorkspaceDocuments,
} from './workspace-tree.js'

const A = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const B = '01BRWAAAAAAAAAAAAAAAAAAAA2'
const C = '01BRWAAAAAAAAAAAAAAAAAAAA3'
const D = '01BRWAAAAAAAAAAAAAAAAAAAA4'

function create(doc: LoroDoc, path: string, documentId: string, body = ''): void {
  createWorkspaceDocumentAtPath(doc, { path, documentId, kind: 'markdown' })
  if (body !== '') documentContainers(doc, documentId).getText(MARKDOWN_BODY_KEY).insert(0, body)
  doc.commit()
}

/** What a restore of `bytes` would place, by document id and body. */
function restored(bytes: Uint8Array): Array<{ documentId: string; body: string }> {
  const scratch = new LoroDoc()
  importWorkspaceSubtree(scratch, bytes)
  return readWorkspaceDocuments(scratch).map(({ documentId }) => ({
    documentId,
    body: documentContainers(scratch, documentId).getText(MARKDOWN_BODY_KEY).toString(),
  }))
}

function removedBy(doc: LoroDoc, edit: (doc: LoroDoc) => void) {
  const since = doc.oplogVersion()
  edit(doc)
  doc.commit()
  return documentsRemovedSince(doc, since)
}

describe('documentsRemovedSince', () => {
  it('answers nothing for an import that only edits content', () => {
    const doc = new LoroDoc()
    create(doc, 'a', A)

    expect(
      removedBy(doc, (d) => documentContainers(d, A).getText(MARKDOWN_BODY_KEY).insert(0, 'x')),
    ).toEqual([])
  })

  it('answers nothing for a move', () => {
    const doc = new LoroDoc()
    create(doc, 'a', A)

    expect(removedBy(doc, (d) => moveWorkspaceNodeToPath(d, 'a', 'b'))).toEqual([])
  })

  it('exports a removed document as it stood before the import', () => {
    const doc = new LoroDoc()
    create(doc, 'a', A, 'before')

    const removed = removedBy(doc, (d) => {
      documentContainers(d, A).getText(MARKDOWN_BODY_KEY).insert(0, 'edited then ')
      deleteWorkspaceDocument(d, { documentId: A })
    })

    expect(removed.map(({ documentId, path }) => ({ documentId, path }))).toEqual([
      { documentId: A, path: 'a' },
    ])
    expect(restored((removed[0] as { bytes: Uint8Array }).bytes)).toEqual([
      { documentId: A, body: 'before' },
    ])
  })

  it('leaves out of a removed document a child the same import moved away', () => {
    const doc = new LoroDoc()
    create(doc, 'a', A)
    create(doc, 'a/b', B)

    const removed = removedBy(doc, (d) => {
      moveWorkspaceNodeToPath(d, 'a/b', 'b')
      deleteWorkspaceDocument(d, { documentId: A })
    })

    expect(removed.map((each) => each.documentId)).toEqual([A])
    expect(restored((removed[0] as { bytes: Uint8Array }).bytes).map((e) => e.documentId)).toEqual([
      A,
    ])
  })

  it('exports on its own a removed document below one that moved away', () => {
    const doc = new LoroDoc()
    create(doc, 'a', A)
    create(doc, 'a/b', B)
    create(doc, 'a/b/c', C, 'deep')

    const removed = removedBy(doc, (d) => {
      deleteWorkspaceDocument(d, { documentId: C })
      moveWorkspaceNodeToPath(d, 'a/b', 'b')
      deleteWorkspaceDocument(d, { documentId: A })
    })

    expect(removed.map((each) => each.documentId).sort()).toEqual([A, C])
    const deep = removed.find((each) => each.documentId === C) as { bytes: Uint8Array }
    expect(restored(deep.bytes)).toEqual([{ documentId: C, body: 'deep' }])
  })

  it('exports the shadowed document, not the owner of its path', () => {
    const left = new LoroDoc()
    left.setPeerId(1n)
    const right = new LoroDoc()
    right.setPeerId(2n)
    create(left, 'a', A, 'left')
    create(right, 'a', B, 'right')
    left.import(right.export({ mode: 'snapshot' }))
    const shadowed = readWorkspaceDocuments(left).find((each) => each.shadowed === true)
    const owner = readWorkspaceDocuments(left).find((each) => each.shadowed !== true)
    if (shadowed === undefined || owner === undefined) throw new Error('no path collision')

    const removed = removedBy(left, (d) => deleteWorkspaceDocument(d, shadowed))

    expect(removed.map((each) => each.documentId)).toEqual([shadowed.documentId])
    expect(restored((removed[0] as { bytes: Uint8Array }).bytes).map((e) => e.documentId)).toEqual([
      shadowed.documentId,
    ])
  })

  it('exports the removed document, not a folder ahead of it at its path', () => {
    const doc = new LoroDoc()
    createWorkspaceDocument(doc, { documentId: A, segment: 'a', kind: 'markdown' })
    ensureFolderPath(doc, ['a', 'c'])
    createWorkspaceDocument(doc, { documentId: B, segment: 'c', kind: 'markdown', parentId: A })

    const removed = removedBy(doc, (d) => deleteWorkspaceDocument(d, { documentId: B }))

    expect(removed.map((each) => each.documentId)).toEqual([B])
    expect(restored((removed[0] as { bytes: Uint8Array }).bytes).map((e) => e.documentId)).toEqual([
      B,
    ])
  })

  it('leaves out of an ancestor a shadowing document that was exported on its own', () => {
    // `x` holds a folder `s` and, after it, a document `s`, so `x/s/y` is
    // claimed twice: the owner under the folder, the shadowed one under the
    // document. Both go with `x` but neither rides it, since the document
    // `s` survives between — so each is exported alone, and `x`'s bytes must
    // carry neither, or a restore of `x` brings the owner back a second time.
    const doc = new LoroDoc()
    createWorkspaceDocument(doc, { documentId: A, segment: 'x', kind: 'markdown' })
    ensureFolderPath(doc, ['x', 's'])
    create(doc, 'x/s/y', B)
    createWorkspaceDocument(doc, { documentId: C, segment: 's', kind: 'markdown', parentId: A })
    createWorkspaceDocument(doc, { documentId: D, segment: 'y', kind: 'markdown', parentId: C })
    const owner = readWorkspaceDocuments(doc).find((each) => each.documentId === B)
    if (owner?.path !== 'x/s/y' || owner.shadowed === true) throw new Error('no path collision')

    const removed = removedBy(doc, (d) => {
      moveWorkspaceDocument(d, { documentId: C })
      deleteWorkspaceDocument(d, { documentId: D })
      deleteWorkspaceDocument(d, { documentId: A })
    })

    expect(removed.map((each) => each.documentId).sort()).toEqual([A, B, D])
    const ancestor = removed.find((each) => each.documentId === A) as { bytes: Uint8Array }
    expect(restored(ancestor.bytes).map((each) => each.documentId)).toEqual([A])
  })

  it('counts a document moved under a node a concurrent delete took', () => {
    const keeper = new LoroDoc()
    keeper.setPeerId(1n)
    create(keeper, 'a', A)
    create(keeper, 'b', B, 'moved')
    const client = keeper.fork()
    client.setPeerId(2n)
    deleteWorkspaceDocument(keeper, { documentId: A })
    moveWorkspaceNodeToPath(client, 'b', 'a/b')
    client.commit()

    const removed = removedBy(keeper, (d) => d.import(client.export({ mode: 'update' })))

    expect(removed.map((each) => each.documentId)).toEqual([B])
    expect(restored((removed[0] as { bytes: Uint8Array }).bytes)).toEqual([
      { documentId: B, body: 'moved' },
    ])
  })

  it('reads a record that has been compacted to a shallow snapshot', () => {
    const doc = new LoroDoc()
    create(doc, 'a', A, 'kept')
    const shallow = LoroDoc.fromSnapshot(
      doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() }),
    )

    const removed = removedBy(shallow, (d) => deleteWorkspaceDocument(d, { documentId: A }))

    expect(restored((removed[0] as { bytes: Uint8Array }).bytes)).toEqual([
      { documentId: A, body: 'kept' },
    ])
  })
})
