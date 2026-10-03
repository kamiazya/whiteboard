/**
 * The trash record and the subtree evacuation around it: what a listing
 * promises about order and damaged rows, and what a restore does with bytes
 * that are not a document.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  exportWorkspaceSubtree,
  forgetTrashEntry,
  importWorkspaceSubtree,
  pruneEmptyFolders,
  readTrashEntries,
  readWorkspaceNodes,
  recordTrashEntry,
  WORKSPACE_TREE_KEY,
} from './workspace-tree.js'

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const ID_C = '01CX5ZZKBKACTAV9WEVGEMMVRZ'

// The stored key, spelled out: a damaged row has to be planted where a peer
// on another version would have put it, and a rename of the constant must not
// quietly move the test with it.
const TRASH_MAP = 'trash'

const BLOB = { algorithm: 'sha-256', digestHex: 'a'.repeat(64) } as const

function workspace(): LoroDoc {
  const doc = new LoroDoc()
  doc.setPeerId(1n)
  return doc
}

function entry(documentId: string, path: string, deletedAt: number) {
  return { documentId, path, deletedAt, blob: BLOB }
}

describe('reading the trash', () => {
  it('lists the most recently deleted first, whatever order they were recorded in', () => {
    const doc = workspace()
    recordTrashEntry(doc, entry(ID_B, 'b', 200))
    recordTrashEntry(doc, entry(ID_A, 'a', 100))
    recordTrashEntry(doc, entry(ID_C, 'c', 300))

    expect(readTrashEntries(doc).map((row) => row.documentId)).toEqual([ID_C, ID_B, ID_A])
  })

  it('skips a damaged row and still lists the others', () => {
    const doc = workspace()
    recordTrashEntry(doc, entry(ID_A, 'a', 100))
    // Written around `recordTrashEntry`, as a peer on another version could.
    doc.getMap(TRASH_MAP).set(ID_B, { documentId: ID_B, path: 'b' })
    doc.commit()

    expect(readTrashEntries(doc).map((row) => row.documentId)).toEqual([ID_A])
  })

  it('skips a row whose blob digest is not 64 lowercase hex digits', () => {
    const doc = workspace()
    const trash = doc.getMap(TRASH_MAP)
    for (const [id, digestHex] of [
      [ID_A, 'a'.repeat(63)],
      [ID_B, 'a'.repeat(65)],
      [ID_C, 'A'.repeat(64)],
    ] as const) {
      trash.set(id, { ...entry(id, id, 1), blob: { algorithm: 'sha-256', digestHex } })
    }
    doc.commit()

    expect(readTrashEntries(doc)).toEqual([])
  })

  it('forgets only the row it names', () => {
    const doc = workspace()
    recordTrashEntry(doc, entry(ID_A, 'a', 100))
    recordTrashEntry(doc, entry(ID_B, 'b', 200))

    forgetTrashEntry(doc, ID_A)

    expect(readTrashEntries(doc).map((row) => row.documentId)).toEqual([ID_B])
  })
})

describe('evacuating and re-importing a subtree', () => {
  it('carries the children of the exported node', () => {
    const doc = workspace()
    createWorkspaceDocumentAtPath(doc, { path: 'a', documentId: ID_A, kind: 'markdown' })
    createWorkspaceDocumentAtPath(doc, { path: 'a/b', documentId: ID_B, kind: 'markdown' })
    const bytes = exportWorkspaceSubtree(doc, 'a')
    if (bytes === null) throw new Error('expected an export')

    const target = workspace()
    importWorkspaceSubtree(target, bytes)

    expect(
      readWorkspaceNodes(target)
        .map((node) => node.path)
        .sort(),
    ).toEqual(['a', 'a/b'])
  })

  it('answers null for a snapshot with no tree root, leaving the workspace untouched', () => {
    const target = workspace()
    const empty = new LoroDoc().export({ mode: 'snapshot' })

    expect(importWorkspaceSubtree(target, empty)).toBeNull()
    expect(readWorkspaceNodes(target)).toEqual([])
  })

  it('answers null for a snapshot whose root is a folder, copying nothing into the workspace', () => {
    const source = new LoroDoc()
    const folder = source.getTree(WORKSPACE_TREE_KEY).createNode()
    folder.data.set('segment', 'folder')
    source.commit()
    const target = workspace()

    expect(importWorkspaceSubtree(target, source.export({ mode: 'snapshot' }), 'under')).toBeNull()
    expect(readWorkspaceNodes(target)).toEqual([])
  })
})

describe('removing nodes by path', () => {
  it('reports a path that names nothing as not removed, without throwing', () => {
    const doc = workspace()
    createWorkspaceDocumentAtPath(doc, { path: 'a', documentId: ID_A, kind: 'markdown' })

    expect(deleteWorkspaceNodeAtPath(doc, 'absent')).toBe(false)
    expect(readWorkspaceNodes(doc)).toHaveLength(1)
  })

  it('prunes a folder holding nothing and keeps one that still holds something', () => {
    const doc = workspace()
    createWorkspaceDocumentAtPath(doc, { path: 'gone/x', documentId: ID_A, kind: 'markdown' })
    createWorkspaceDocumentAtPath(doc, { path: 'kept/y', documentId: ID_B, kind: 'markdown' })
    deleteWorkspaceNodeAtPath(doc, 'gone/x')

    pruneEmptyFolders(doc)

    expect(
      readWorkspaceNodes(doc)
        .map((node) => `${node.type}:${node.path}`)
        .sort(),
    ).toEqual(['document:kept/y', 'folder:kept'])
  })
})
