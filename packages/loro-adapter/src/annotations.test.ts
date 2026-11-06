/**
 * `readAnnotations` is the format-agnostic half of the annotation layer
 * (ADR-0026 step 2): the plane is stored one level above content, so reading
 * it must not require the document to have a canvas.
 *
 * It is also where the plane BEFORE threads is refused. Nothing reads the
 * retired `comments` map any more, so a record still holding rows there would
 * otherwise read as having no conversation at all — the comments lost with no
 * word said, which owner decision 27 rules out.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  holdsRetiredCommentPlane,
  RetiredCommentPlaneError,
  readAnnotations,
} from './annotations.js'
import { writeCommentThread } from './comment-threads.js'
import { writeMarkdownBody } from './markdown-body.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const THREAD: CommentThread = {
  id: 't1',
  anchor: { kind: 'spatial', nodeId: 'n1', x: 40, y: 50 },
  status: 'open',
  createdAt: '2026-09-03T00:00:00.000Z',
  messages: [{ id: 'm1', body: 'tighten this' }],
}

/** Seeds the retired `comments` map the way the pre-threads writer did. */
function seedRetired(doc: LoroDoc, comment: Record<string, unknown>): void {
  doc.getMap('comments').set(String(comment.id), comment)
  doc.commit()
}

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('readAnnotations', () => {
  it('reads a document that has no canvas at all', () => {
    // The point of the whole reader. This document holds a markdown body and
    // no `canvas` map, so `readSpatialCanvas` has nothing to project through.
    const doc = new LoroDoc()
    writeMarkdownBody(doc, '# a note')
    writeCommentThread(doc, THREAD)
    expect(readAnnotations(doc)).toEqual([THREAD])
  })

  it('refuses a document still holding comments in the retired plane, rather than reading none', () => {
    const doc = new LoroDoc()
    writeCommentThread(doc, THREAD)
    seedRetired(doc, { id: 'c1', x: 10, y: 20, text: 'from before threads' })
    expect(holdsRetiredCommentPlane(doc)).toBe(true)
    expect(() => readAnnotations(doc)).toThrow(RetiredCommentPlaneError)
    expect(() => readAnnotations(doc)).toThrow(/1 comment .*older version/)
  })

  it('reads a document whose retired plane is there and empty', () => {
    // Every document created before the plane retired had it pre-attached,
    // so an EMPTY one is the common case and holds nothing to lose.
    const doc = new LoroDoc()
    doc.getMap('comments')
    writeCommentThread(doc, THREAD)
    expect(holdsRetiredCommentPlane(doc)).toBe(false)
    expect(readAnnotations(doc)).toEqual([THREAD])
  })

  it('looks at a workspace document without opening the retired container on it', () => {
    // A tree node opens a container by WRITING it, and a read that wrote
    // would clear the undo manager's redo stack — so the probe must not.
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, {
      path: 'board',
      documentId: DOCUMENT_ID,
      kind: 'spatial',
      name: 'Board',
    })
    doc.commit()
    const before = doc.oplogVersion().encode()
    expect(holdsRetiredCommentPlane(documentContainers(doc, DOCUMENT_ID))).toBe(false)
    expect(readAnnotations(documentContainers(doc, DOCUMENT_ID))).toEqual([])
    doc.commit()
    expect(doc.oplogVersion().encode()).toEqual(before)
  })
})
