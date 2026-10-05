import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readMarkdownBody, writeMarkdownBody } from './markdown-body.js'
import { duplicateWorkspaceDocument } from './workspace-duplicate.js'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
} from './workspace-tree.js'

const SOURCE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const COPY = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const OTHER = '01CX5ZZKBKACTAV9WEVGEMMVRZ'

function workspaceWithRoadmap(): LoroDoc {
  const doc = new LoroDoc()
  doc.setPeerId(1n)
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/roadmap',
    documentId: SOURCE,
    kind: 'markdown',
    name: 'Roadmap',
  })
  writeMarkdownBody(documentContainers(doc, SOURCE), '# Roadmap\n\nship it')
  doc.commit()
  return doc
}

describe('duplicateWorkspaceDocument', () => {
  it('copies the content into a new document at the given path, with the given name', () => {
    const doc = workspaceWithRoadmap()

    const copy = duplicateWorkspaceDocument(doc, {
      sourceDocumentId: SOURCE,
      documentId: COPY,
      path: 'notes/roadmap-copy',
      name: 'Roadmap (copy)',
    })

    expect(copy).toMatchObject({
      documentId: COPY,
      path: 'notes/roadmap-copy',
      kind: 'markdown',
      name: 'Roadmap (copy)',
      // Written by the verb on the person's behalf, like a name typed at create.
      nameChosen: true,
    })
    expect(readMarkdownBody(documentContainers(doc, COPY))).toBe('# Roadmap\n\nship it')
    expect(copy?.contentDigest).toBe(resolveWorkspaceDocumentById(doc, SOURCE)?.contentDigest)
  })

  it('shares nothing with the source: an edit to one leaves the other alone', () => {
    const doc = workspaceWithRoadmap()
    duplicateWorkspaceDocument(doc, {
      sourceDocumentId: SOURCE,
      documentId: COPY,
      path: 'notes/roadmap-copy',
      name: 'Roadmap (copy)',
    })

    writeMarkdownBody(documentContainers(doc, SOURCE), 'changed after the copy')
    setWorkspaceDocumentName(doc, { documentId: SOURCE, name: 'Renamed' })

    expect(readMarkdownBody(documentContainers(doc, COPY))).toBe('# Roadmap\n\nship it')
    expect(resolveWorkspaceDocumentById(doc, COPY)?.name).toBe('Roadmap (copy)')
  })

  it('answers null and writes nothing for a source the workspace does not hold', () => {
    const doc = workspaceWithRoadmap()
    const before = doc.oplogVersion()

    expect(
      duplicateWorkspaceDocument(doc, {
        sourceDocumentId: OTHER,
        documentId: COPY,
        path: 'notes/roadmap-copy',
        name: 'x',
      }),
    ).toBeNull()
    expect(doc.oplogVersion().compare(before)).toBe(0)
  })

  it('answers null and writes nothing when a document already owns the path', () => {
    const doc = workspaceWithRoadmap()
    createWorkspaceDocumentAtPath(doc, { path: 'taken', documentId: OTHER, kind: 'spatial' })
    const before = doc.oplogVersion()

    expect(
      duplicateWorkspaceDocument(doc, {
        sourceDocumentId: SOURCE,
        documentId: COPY,
        path: 'taken',
        name: 'x',
      }),
    ).toBeNull()
    expect(doc.oplogVersion().compare(before)).toBe(0)
    expect(
      readWorkspaceDocuments(doc)
        .map((entry) => entry.documentId)
        .sort(),
    ).toEqual([OTHER, SOURCE].sort())
  })
})
