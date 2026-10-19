/**
 * Finding what one update removed must cost one pass over the record as it
 * stood before, not one per removed document: a keeper runs it on the serving
 * loop for every update that touches the tree, and one update may remove
 * every document a workspace holds.
 *
 * Counted rather than timed. What scales is how many tree-node handles the
 * engine materialises — every `roots()` / `children()` entry — which is what
 * re-resolving each removed document's path from the root costs, and every
 * path-ancestry test, which is what a pairwise "is this one below that one"
 * costs. Both are bounded by a constant times the record's size.
 */
import { LoroDoc, LoroTree, LoroTreeNode, type VersionVector } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentsRemovedSince } from './removed-documents.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  moveWorkspaceNodeToPath,
} from './workspace-tree.js'

const ancestry = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@kamiazya/whiteboard-model', async (original) => {
  const actual = await original<typeof import('@kamiazya/whiteboard-model')>()
  return {
    ...actual,
    isSelfOrDescendant: (path: string, ancestor: string) => {
      ancestry.calls += 1
      return actual.isSelfOrDescendant(path, ancestor)
    },
  }
})

const N = 200
/** Per document in the record: one walk before the update and one after cost about two. */
const PER_DOCUMENT = 4

const id = (i: number) => `01BRW${String(i).padStart(21, '0')}`

function seeded(paths: readonly string[]): LoroDoc {
  const doc = new LoroDoc()
  for (const [i, path] of paths.entries()) {
    createWorkspaceDocumentAtPath(doc, { path, documentId: id(i), kind: 'markdown' })
  }
  doc.commit()
  return doc
}

function counted(doc: LoroDoc, since: VersionVector) {
  const roots = vi.spyOn(LoroTree.prototype, 'roots')
  const children = vi.spyOn(LoroTreeNode.prototype, 'children')
  ancestry.calls = 0
  const removed = documentsRemovedSince(doc, since)
  const handles = [...roots.mock.results, ...children.mock.results].reduce(
    (sum, { value }) => sum + (Array.isArray(value) ? value.length : 0),
    0,
  )
  return { removed, handles, ancestry: ancestry.calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('documentsRemovedSince cost', () => {
  it('reads the record once when an update removes every root document', () => {
    const paths = Array.from({ length: N }, (_, i) => `d${i}`)
    const doc = seeded(paths)
    const since = doc.oplogVersion()
    for (const path of paths) deleteWorkspaceNodeAtPath(doc, path)

    const { removed, handles, ancestry } = counted(doc, since)

    expect(removed).toHaveLength(N)
    expect(handles).toBeLessThanOrEqual(PER_DOCUMENT * N)
    expect(ancestry).toBeLessThanOrEqual(PER_DOCUMENT * N)
  })

  it('reads the record once when an update removes a folder of documents', () => {
    const doc = seeded(Array.from({ length: N }, (_, i) => `f/d${i}`))
    const since = doc.oplogVersion()
    deleteWorkspaceNodeAtPath(doc, 'f')

    const { removed, handles, ancestry } = counted(doc, since)

    expect(removed).toHaveLength(N)
    expect(handles).toBeLessThanOrEqual(PER_DOCUMENT * N)
    expect(ancestry).toBeLessThanOrEqual(PER_DOCUMENT * N)
  })

  it('reads the record once when a removed parent leaves children behind', () => {
    const doc = seeded(['p', ...Array.from({ length: N }, (_, i) => `p/d${i}`)])
    const since = doc.oplogVersion()
    for (let i = 0; i < N; i += 2) moveWorkspaceNodeToPath(doc, `p/d${i}`, `m${i}`)
    deleteWorkspaceNodeAtPath(doc, 'p')

    const { removed, handles, ancestry } = counted(doc, since)

    // The parent carries every child the update did not move out.
    expect(removed).toHaveLength(1)
    expect(handles).toBeLessThanOrEqual(PER_DOCUMENT * N)
    expect(ancestry).toBeLessThanOrEqual(PER_DOCUMENT * N)
  })

  it('reads the record once for removals nested below removals and survivors', () => {
    // Root documents, each holding a survivor that moves out and, below that,
    // a document removed with the root — so each root exports on its own and
    // so does each grandchild.
    const paths = Array.from({ length: N / 4 }, (_, i) => [
      `r${i}`,
      `r${i}/s`,
      `r${i}/s/g`,
      `f/d${i}`,
    ]).flat()
    const doc = seeded(paths)
    const since = doc.oplogVersion()
    for (let i = 0; i < N / 4; i++) {
      deleteWorkspaceNodeAtPath(doc, `r${i}/s/g`)
      moveWorkspaceNodeToPath(doc, `r${i}/s`, `kept${i}`)
      deleteWorkspaceNodeAtPath(doc, `r${i}`)
    }
    deleteWorkspaceNodeAtPath(doc, 'f')

    const { removed, handles, ancestry } = counted(doc, since)

    expect(removed).toHaveLength((3 * N) / 4)
    expect(handles).toBeLessThanOrEqual(PER_DOCUMENT * N)
    expect(ancestry).toBeLessThanOrEqual(PER_DOCUMENT * N)
  })
})
