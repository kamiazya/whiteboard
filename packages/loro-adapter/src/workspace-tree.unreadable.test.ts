import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
  unreadableWorkspaceNodes,
} from './workspace-tree.js'

const ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ'

function seeded(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'folder/page', documentId: ID, kind: 'spatial' })
  return doc
}

function tamper(doc: LoroDoc, segment: string, key: string, value: string): void {
  for (const node of doc.getTree('tree').getNodes()) {
    if ((node.data.toJSON() as { segment?: string }).segment === segment) node.data.set(key, value)
  }
  doc.commit()
}

describe('unreadableWorkspaceNodes', () => {
  it('is empty for a record every node of which this build reads', () => {
    expect(unreadableWorkspaceNodes(seeded())).toEqual([])
  })

  it('names a folder carrying a key this build does not know, which hides its documents', () => {
    const doc = seeded()
    tamper(doc, 'folder', 'icon', 'open')
    expect(readWorkspaceDocuments(doc)).toEqual([])
    expect(unreadableWorkspaceNodes(doc)).toHaveLength(1)
  })

  it('names a document of a kind this build lacks', () => {
    const doc = seeded()
    tamper(doc, 'page', 'kind', 'future-kind')
    expect(readWorkspaceDocuments(doc)).toEqual([])
    expect(unreadableWorkspaceNodes(doc)).toHaveLength(1)
  })
})
