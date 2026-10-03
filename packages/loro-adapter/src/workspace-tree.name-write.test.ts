import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
  setWorkspaceDocumentName,
  unreadableWorkspaceNodes,
} from './workspace-tree.js'

const A = '01HZZZZZZZZZZZZZZZZZZZZZZA'
const B = '01HZZZZZZZZZZZZZZZZZZZZZZB'

function seeded(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'a', documentId: A, kind: 'markdown', name: 'Named' })
  createWorkspaceDocumentAtPath(doc, { path: 'a/b', documentId: B, kind: 'markdown' })
  return doc
}

describe('setWorkspaceDocumentName with a blank name', () => {
  it.each(['', ' ', ' \t\n '])('clears the name %j and keeps the subtree readable', (name) => {
    const doc = seeded()
    setWorkspaceDocumentName(doc, { documentId: A, name })
    const entries = readWorkspaceDocuments(doc)
    expect(entries.map((e) => e.path)).toEqual(['a', 'a/b'])
    expect(entries[0]?.name).toBeUndefined()
    expect(unreadableWorkspaceNodes(doc)).toEqual([])
  })

  it('keeps a non-blank name exactly as given', () => {
    const doc = seeded()
    setWorkspaceDocumentName(doc, { documentId: A, name: ' Spaced ' })
    expect(readWorkspaceDocuments(doc)[0]?.name).toBe(' Spaced ')
  })
})
