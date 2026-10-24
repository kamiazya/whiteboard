/**
 * A folder's display name: what a person reads for a folder, kept apart from
 * its segment, which stays the address.
 *
 * The name lives on the folder NODE, so it travels with a move and merges
 * per key like every other node field. What is pinned here is what the
 * listing answers when the tree holds more than one folder node at a path —
 * which concurrent creation makes ordinary — and what happens to a name when
 * the folder stops being a folder.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  moveWorkspaceNodeToPath,
  pruneEmptyFolders,
  readWorkspaceDocuments,
  readWorkspaceFolderNames,
  readWorkspaceNodes,
  setWorkspaceFolderName,
} from './workspace-tree.js'

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

function workspace(peer = 1n): LoroDoc {
  const doc = new LoroDoc()
  doc.setPeerId(peer)
  return doc
}

function withNote(doc: LoroDoc, path: string, documentId = ID_A): void {
  createWorkspaceDocumentAtPath(doc, { path, documentId, kind: 'markdown' })
}

describe('a folder display name', () => {
  it('is listed for its folder while the path and the documents under it stay put', () => {
    const doc = workspace()
    withNote(doc, 'week-6/plan')

    expect(setWorkspaceFolderName(doc, { path: 'week-6', name: 'Week 6' })).toBe(true)

    expect(readWorkspaceFolderNames(doc)).toEqual([{ path: 'week-6', name: 'Week 6' }])
    expect(readWorkspaceDocuments(doc).map((entry) => entry.path)).toEqual(['week-6/plan'])
    expect(readWorkspaceNodes(doc)).toContainEqual({
      type: 'folder',
      segment: 'week-6',
      path: 'week-6',
      name: 'Week 6',
    })
  })

  it('lists nothing for a folder nobody named', () => {
    const doc = workspace()
    withNote(doc, 'a/b/c')
    expect(readWorkspaceFolderNames(doc)).toEqual([])
    expect(readWorkspaceNodes(doc).find((node) => node.path === 'a')).not.toHaveProperty('name')
  })

  it('stores the name trimmed', () => {
    const doc = workspace()
    withNote(doc, 'a/x')
    setWorkspaceFolderName(doc, { path: 'a', name: '  Archive  ' })
    expect(readWorkspaceFolderNames(doc)).toEqual([{ path: 'a', name: 'Archive' }])
  })

  it('is cleared by a write with no name', () => {
    const doc = workspace()
    withNote(doc, 'a/x')
    setWorkspaceFolderName(doc, { path: 'a', name: 'Archive' })

    expect(setWorkspaceFolderName(doc, { path: 'a' })).toBe(true)

    expect(readWorkspaceFolderNames(doc)).toEqual([])
  })

  it('answers false and writes nothing where no folder node stands', () => {
    const doc = workspace()
    withNote(doc, 'a')
    withNote(doc, 'a/x', ID_B)
    const before = doc.oplogVersion()

    // `a` is a document holding a child, not a folder; `zzz` is nothing.
    expect(setWorkspaceFolderName(doc, { path: 'a', name: 'Archive' })).toBe(false)
    expect(setWorkspaceFolderName(doc, { path: 'zzz', name: 'Archive' })).toBe(false)

    expect(doc.oplogVersion().toJSON()).toEqual(before.toJSON())
  })

  it('refuses a name the shared folder-name rule refuses, before writing', () => {
    const doc = workspace()
    withNote(doc, 'a/x')
    expect(() => setWorkspaceFolderName(doc, { path: 'a', name: 'a/b' })).toThrow(/"\/"/)
    expect(() => setWorkspaceFolderName(doc, { path: 'a', name: '   ' })).toThrow(/blank/)
    expect(readWorkspaceFolderNames(doc)).toEqual([])
  })

  it('travels with the folder when it moves', () => {
    const doc = workspace()
    withNote(doc, 'a/x')
    setWorkspaceFolderName(doc, { path: 'a', name: 'Archive' })

    moveWorkspaceNodeToPath(doc, 'a', 'old/a')

    expect(readWorkspaceFolderNames(doc)).toEqual([{ path: 'old/a', name: 'Archive' }])
  })

  it('goes when the folder is promoted into a document created at its path', () => {
    const doc = workspace()
    withNote(doc, 'a/x')
    setWorkspaceFolderName(doc, { path: 'a', name: 'Archive' })

    withNote(doc, 'a', ID_B)

    expect(readWorkspaceFolderNames(doc)).toEqual([])
    expect(readWorkspaceDocuments(doc).find((entry) => entry.path === 'a')).not.toHaveProperty(
      'name',
    )
  })

  it('goes with a folder emptied and pruned', () => {
    const doc = workspace()
    withNote(doc, 'a/x')
    setWorkspaceFolderName(doc, { path: 'a', name: 'Archive' })

    deleteWorkspaceNodeAtPath(doc, 'a/x')
    pruneEmptyFolders(doc)

    expect(readWorkspaceFolderNames(doc)).toEqual([])
  })
})

describe('two folder nodes at one path', () => {
  /** Two replicas each make `a` for their own document, then merge: two nodes at `a`. */
  function contested(): { left: LoroDoc; right: LoroDoc } {
    const left = workspace(1n)
    const right = workspace(2n)
    withNote(left, 'a/x', ID_A)
    withNote(right, 'a/y', ID_B)
    return { left, right }
  }

  function merged(from: LoroDoc, into: LoroDoc): LoroDoc {
    into.import(from.export({ mode: 'update' }))
    return into
  }

  it('lists the path once, under the first NAMED node in tree order, on both replicas', () => {
    const { left, right } = contested()
    setWorkspaceFolderName(right, { path: 'a', name: 'Right' })
    const leftView = merged(right, left)
    const rightView = merged(left, right)

    expect(readWorkspaceNodes(leftView).filter((node) => node.path === 'a')).toHaveLength(2)
    expect(readWorkspaceFolderNames(leftView)).toEqual([{ path: 'a', name: 'Right' }])
    expect(readWorkspaceFolderNames(rightView)).toEqual(readWorkspaceFolderNames(leftView))
  })

  it('keeps both names when each replica named its own node, and both agree which shows', () => {
    const { left, right } = contested()
    setWorkspaceFolderName(left, { path: 'a', name: 'Left' })
    setWorkspaceFolderName(right, { path: 'a', name: 'Right' })
    const leftView = merged(right, left)
    const rightView = merged(left, right)

    const named = readWorkspaceNodes(leftView).flatMap((node) =>
      node.type === 'folder' && node.name !== undefined ? [node.name] : [],
    )
    expect(named.sort()).toEqual(['Left', 'Right'])
    expect(readWorkspaceFolderNames(rightView)).toEqual(readWorkspaceFolderNames(leftView))
  })

  it('clears the name from every node at the path', () => {
    const { left, right } = contested()
    setWorkspaceFolderName(left, { path: 'a', name: 'Left' })
    setWorkspaceFolderName(right, { path: 'a', name: 'Right' })
    const view = merged(right, left)

    setWorkspaceFolderName(view, { path: 'a' })

    expect(readWorkspaceFolderNames(view)).toEqual([])
  })
})
