import type { CommentThread, Proposal } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readCommentThreads, writeCommentThread } from './comment-threads.js'
import { readMarkdownBody, writeMarkdownBody } from './markdown-body.js'
import { readProposals, writeProposal } from './proposals.js'
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

const THREAD: CommentThread = {
  id: 't1',
  anchor: { kind: 'document' },
  status: 'open',
  createdAt: '2026-09-02T00:00:00.000Z',
  messages: [{ id: 'm1', body: 'which release?', author: 'human:yuki' }],
}

const PROPOSAL: Proposal = {
  id: 'p1',
  author: 'process:layout-agent',
  createdAt: '2026-09-06T00:00:00.000Z',
  changes: [
    {
      id: 'c1',
      status: 'open',
      op: 'node.patch',
      nodeId: 'n1',
      patch: { x: 4 },
      assumed: { x: 1 },
    },
  ],
}

function annotatedRoadmap(): LoroDoc {
  const doc = workspaceWithRoadmap()
  const source = documentContainers(doc, SOURCE)
  writeCommentThread(source, THREAD)
  writeProposal(source, PROPOSAL)
  doc.commit()
  return doc
}

const COPY_INPUT = {
  sourceDocumentId: SOURCE,
  documentId: COPY,
  path: 'notes/roadmap-copy',
  name: 'Roadmap (copy)',
}

describe('duplicateWorkspaceDocument and the annotation layer', () => {
  it('carries the comment threads and proposals by default', () => {
    const doc = annotatedRoadmap()

    duplicateWorkspaceDocument(doc, COPY_INPUT)

    const copy = documentContainers(doc, COPY)
    expect(readCommentThreads(copy).map((thread) => thread.id)).toEqual(['t1'])
    expect(readProposals(copy).map((proposal) => proposal.id)).toEqual(['p1'])
  })

  it('leaves the threads and proposals behind when asked, and the source keeps them', () => {
    const doc = annotatedRoadmap()

    const entry = duplicateWorkspaceDocument(doc, { ...COPY_INPUT, withoutAnnotations: true })

    expect(entry).toMatchObject({ documentId: COPY, name: 'Roadmap (copy)' })
    const copy = documentContainers(doc, COPY)
    expect(readMarkdownBody(copy)).toBe('# Roadmap\n\nship it')
    expect(readCommentThreads(copy)).toEqual([])
    expect(readProposals(copy)).toEqual([])
    const source = documentContainers(doc, SOURCE)
    expect(readCommentThreads(source).map((thread) => thread.id)).toEqual(['t1'])
    expect(readProposals(source).map((proposal) => proposal.id)).toEqual(['p1'])
  })

  // The pre-threads plane is still read as a fallback, so a copy carrying it
  // would show the conversation it was meant to leave behind.
  it('leaves a legacy comments plane behind too', () => {
    const doc = workspaceWithRoadmap()
    documentContainers(doc, SOURCE)
      .getMap('comments')
      .set('legacy-1', { id: 'legacy-1', x: 1, y: 2, text: 'old' })
    doc.commit()

    duplicateWorkspaceDocument(doc, { ...COPY_INPUT, withoutAnnotations: true })

    expect(documentContainers(doc, COPY).getMap('comments').size).toBe(0)
  })
})
