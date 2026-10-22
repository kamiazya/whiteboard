/**
 * Whatever one update removes, the trash rows it yields restore every removed
 * document exactly once and nothing that survived — judged only by what the
 * rows' bytes restore, never by how the rows were chosen.
 *
 * The trees draw segments from a two-letter alphabet under folders and
 * documents alike, so paths collide across branches and between a folder and
 * a document: the arrangement where a path stops saying what holds what.
 */
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, type TreeID } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { documentsRemovedSince } from './removed-documents.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  createWorkspaceDocument,
  deleteWorkspaceNode,
  documentContainers,
  importWorkspaceSubtree,
  readPlacedWorkspaceDocuments,
  readWorkspaceDocuments,
  WORKSPACE_TREE_KEY,
} from './workspace-tree.js'

const id = (i: number) => `01BRW${String(i).padStart(21, '0')}`

const nodeArbitrary = fc.record({
  /** Modulo one more than the nodes before this one; the extra value is the root. */
  parent: fc.nat({ max: 63 }),
  document: fc.constantFrom(true, true, false),
  segment: fc.constantFrom('a', 'b'),
})
/**
 * Node indices, modulo the node count. Moves run before deletes: a move after
 * a delete can only move a node the delete left alone, which removes nothing,
 * while a move before one is what leaves a survivor below a removed document.
 */
const editsArbitrary = fc.record({
  movesToRoot: fc.array(fc.nat({ max: 63 }), { minLength: 1, maxLength: 3 }),
  deletes: fc.array(fc.nat({ max: 63 }), { minLength: 1, maxLength: 3 }),
})

type DrawnNode = typeof nodeArbitrary extends fc.Arbitrary<infer T> ? T : never

function build(nodes: ReadonlyArray<DrawnNode>) {
  const doc = new LoroDoc()
  const tree = doc.getTree(WORKSPACE_TREE_KEY)
  const ids: TreeID[] = []
  for (const [i, each] of nodes.entries()) {
    const parent = ids[each.parent % (i + 1)]
    if (each.document) {
      const documentId = id(i)
      createWorkspaceDocument(doc, { documentId, segment: each.segment, kind: 'markdown' })
      documentContainers(doc, documentId).getText(MARKDOWN_BODY_KEY).insert(0, documentId)
      const placed = readPlacedWorkspaceDocuments(doc).find((d) => d.documentId === documentId)
      if (placed === undefined) throw new Error('a created document did not place')
      if (parent !== undefined) tree.move(placed.id, parent)
      ids.push(placed.id)
    } else {
      const folder = parent === undefined ? tree.createNode() : tree.createNode(parent)
      folder.data.set('segment', each.segment)
      ids.push(folder.id)
    }
    doc.commit()
  }
  return { doc, ids }
}

function restoredIds(bytes: Uint8Array): string[] {
  const scratch = new LoroDoc()
  importWorkspaceSubtree(scratch, bytes)
  return readWorkspaceDocuments(scratch).map(({ documentId }) => {
    const body = documentContainers(scratch, documentId).getText(MARKDOWN_BODY_KEY).toString()
    if (body !== documentId) throw new Error(`${documentId} restored with another's body`)
    return documentId
  })
}

/**
 * Measured over 100 runs, thirty times: removal 80-94, a survivor under a
 * removed document 5-22 (mean 14), a path ancestor on another branch 4-15
 * (mean 10). With no move drawn the survivor arrangement fell to 2 once in CI,
 * which is why every draw makes at least one.
 */
const REMOVAL_FLOOR = 50
const ARRANGEMENT_FLOOR = 3
/** The arrangements the property exists for, counted so a sparse generator fails loudly. */
const reached = { removal: 0, survivorUnderRemoved: 0, pathAncestorOnAnotherBranch: 0 }

/** Which of `reached`'s arrangements the record as it stood before the update holds. */
function tally(before: LoroDoc, alive: ReadonlySet<string>): void {
  const placed = readPlacedWorkspaceDocuments(before)
  const removed = placed.filter((each) => !alive.has(each.documentId))
  if (removed.length === 0) return
  reached.removal += 1
  const gone = (documentId: string | undefined) =>
    documentId !== undefined && !alive.has(documentId)
  if (placed.some((each) => alive.has(each.documentId) && gone(each.above))) {
    reached.survivorUnderRemoved += 1
  }
  // A removed document directly below a path a removed document holds,
  // where that document is not the one on its own parent chain.
  const atPath = (path: string) => placed.filter((each) => each.path === path)
  const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
  if (
    removed.some((each) =>
      atPath(parentPath(each.path)).some((q) => gone(q.documentId) && q.documentId !== each.above),
    )
  ) {
    reached.pathAncestorOnAnotherBranch += 1
  }
}

describe('documentsRemovedSince', () => {
  afterAllFloor(['restores every removed document exactly once, and no survivor'], () => {
    expect(reached.removal).toBeGreaterThanOrEqual(REMOVAL_FLOOR)
    expect(reached.survivorUnderRemoved).toBeGreaterThanOrEqual(ARRANGEMENT_FLOOR)
    expect(reached.pathAncestorOnAnotherBranch).toBeGreaterThanOrEqual(ARRANGEMENT_FLOOR)
  })

  fcTest.prop(
    [fc.array(nodeArbitrary, { minLength: 2, maxLength: 12 }), editsArbitrary],
    withDefaults({ numRuns: 100 }),
  )('restores every removed document exactly once, and no survivor', (nodes, edits) => {
    const { doc, ids } = build(nodes)
    const tree = doc.getTree(WORKSPACE_TREE_KEY)
    const was = readWorkspaceDocuments(doc).map((each) => each.documentId)
    const since = doc.oplogVersion()
    const before = doc.fork()
    const target = (index: number) => ids[index % ids.length] as TreeID
    for (const index of edits.movesToRoot) tree.move(target(index), undefined)
    doc.commit()
    for (const index of edits.deletes) deleteWorkspaceNode(doc, target(index))
    const alive = new Set(readWorkspaceDocuments(doc).map((each) => each.documentId))
    tally(before, alive)

    const removed = documentsRemovedSince(doc, since)

    const carried = removed.flatMap((each) => {
      const restored = restoredIds(each.bytes)
      expect(restored[0]).toBe(each.documentId)
      return restored
    })
    expect(carried.sort()).toEqual(was.filter((each) => !alive.has(each)).sort())
  })
})
