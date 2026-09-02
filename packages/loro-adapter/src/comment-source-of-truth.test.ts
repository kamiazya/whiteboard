/**
 * The threads plane is where a comment LIVES (ADR-0026 step 2). Every writer
 * puts one there and `readSpatialCanvas` projects it back, so the canvas API
 * every consumer already speaks is unchanged while the storage underneath it
 * moves once rather than twice.
 */
import type { CanvasComment } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readCommentThreads, writeThreadMessage } from './comment-threads.js'
import {
  deleteCanvasComment,
  readSpatialCanvas,
  writeCanvasComment,
  writeSpatialCanvas,
} from './loro-bridge.js'

const COMMENT: CanvasComment = {
  id: 'c1',
  x: 40,
  y: 50,
  text: 'tighten this',
  author: 'human:yuki',
  createdAt: '2026-09-02T00:00:00.000Z',
  targetNodeId: 'n1',
}

function commentsOf(doc: LoroDoc): CanvasComment[] {
  return readSpatialCanvas(doc)['x-whiteboard']?.comments ?? []
}

describe('the threads plane is the source of truth for comments', () => {
  it('stores a comment as a thread and reads it back through the canvas', () => {
    const doc = new LoroDoc()
    writeCanvasComment(doc, COMMENT)
    expect(readCommentThreads(doc)).toHaveLength(1)
    expect(commentsOf(doc)).toEqual([COMMENT])
  })

  it('writes nothing to the legacy comments map', () => {
    const doc = new LoroDoc()
    writeCanvasComment(doc, COMMENT)
    writeSpatialCanvas(doc, { nodes: [], edges: [], 'x-whiteboard': { comments: [COMMENT] } })
    expect(doc.getMap('comments').keys()).toEqual([])
  })

  it('carries resolution and the node reference across the projection', () => {
    // A thread's status has two values, so the projection emits the canonical
    // encoding of each: `resolved: true`, or the field absent. A caller that
    // wrote `resolved: false` reads back an open comment with no field —
    // `canvasCommentSchema` already makes them the same state, and keeping
    // two spellings of "open" is what lets a reader treat one as unknown.
    const doc = new LoroDoc()
    writeCanvasComment(doc, { ...COMMENT, resolved: true })
    expect(commentsOf(doc)[0]).toEqual({ ...COMMENT, resolved: true })
    writeCanvasComment(doc, { ...COMMENT, resolved: false })
    expect(commentsOf(doc)[0]).toEqual(COMMENT)
  })

  it('deletes the thread, not just a legacy entry', () => {
    const doc = new LoroDoc()
    writeCanvasComment(doc, COMMENT)
    deleteCanvasComment(doc, COMMENT.id)
    expect(readCommentThreads(doc)).toEqual([])
    expect(commentsOf(doc)).toEqual([])
  })

  it('states the whole truth on a resync, dropping a thread the canvas omits', () => {
    const doc = new LoroDoc()
    writeCanvasComment(doc, COMMENT)
    writeCanvasComment(doc, { ...COMMENT, id: 'c2' })
    writeSpatialCanvas(doc, { nodes: [], edges: [], 'x-whiteboard': { comments: [COMMENT] } })
    expect(commentsOf(doc).map((c) => c.id)).toEqual(['c1'])
  })

  it('projects a thread with replies as its first message, which is all a canvas comment can hold', () => {
    // Lossy on purpose and lossless in practice: nothing can write a reply
    // yet. When the panel can (ADR-0026 step 3), it reads threads directly
    // and this projection stops being the only view.
    const doc = new LoroDoc()
    writeCanvasComment(doc, COMMENT)
    writeThreadMessage(doc, COMMENT.id, {
      id: 'm2',
      body: 'a reply',
      createdAt: '2026-09-03T00:00:00.000Z',
    })
    expect(commentsOf(doc)[0]?.text).toBe('tighten this')
  })
})

describe('a document written before the threads plane', () => {
  /** Seeds the legacy `comments` map the way the previous writer did. */
  function seedLegacy(doc: LoroDoc, comment: CanvasComment): void {
    doc.getMap('comments').set(comment.id, { ...comment })
    doc.commit()
  }

  it('still reads its comments, without the read writing anything', () => {
    const doc = new LoroDoc()
    seedLegacy(doc, COMMENT)
    const before = doc.version().toJSON()
    expect(commentsOf(doc)).toEqual([COMMENT])
    expect(doc.version().toJSON()).toEqual(before)
  })

  it('moves to the threads plane on the first write, leaving nothing behind', () => {
    const doc = new LoroDoc()
    seedLegacy(doc, COMMENT)
    writeCanvasComment(doc, { ...COMMENT, id: 'c2', text: 'a newer one' })
    expect(doc.getMap('comments').keys()).toEqual([])
    expect(commentsOf(doc).map((c) => c.id).sort()).toEqual(['c1', 'c2'])
  })

  it('does not resurrect a legacy entry the thread plane has already deleted', () => {
    // The trap the union read opens: a legacy row outliving its migrated
    // thread would come back as a comment the user closed.
    const doc = new LoroDoc()
    seedLegacy(doc, COMMENT)
    writeCanvasComment(doc, COMMENT)
    deleteCanvasComment(doc, COMMENT.id)
    expect(commentsOf(doc)).toEqual([])
  })
})
