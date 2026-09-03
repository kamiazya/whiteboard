/**
 * `readAnnotations` is the format-agnostic half of the annotation layer
 * (ADR-0026 step 2): the plane is stored one level above content, so reading
 * it must not require the document to have a canvas.
 *
 * `readSpatialCanvas` could never serve that — it is the canvas reader, and a
 * markdown document's threads were unreachable rather than absent.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readAnnotations } from './annotations.js'
import { writeCommentThread } from './comment-threads.js'
import { writeMarkdownBody } from './loro-bridge.js'

const THREAD: CommentThread = {
  id: 't1',
  anchor: { kind: 'spatial', nodeId: 'n1', x: 40, y: 50 },
  status: 'open',
  createdAt: '2026-09-03T00:00:00.000Z',
  messages: [{ id: 'm1', body: 'tighten this' }],
}

/** Seeds the legacy `comments` map the way the pre-threads writer did. */
function seedLegacy(doc: LoroDoc, comment: Record<string, unknown>): void {
  doc.getMap('comments').set(String(comment.id), comment)
  doc.commit()
}

describe('readAnnotations', () => {
  it('reads a document that has no canvas at all', () => {
    // The point of the whole reader. This document holds a markdown body and
    // no `canvas` map, so `readSpatialCanvas` has nothing to project through.
    const doc = new LoroDoc()
    writeMarkdownBody(doc, '# a note')
    writeCommentThread(doc, THREAD)
    expect(readAnnotations(doc)).toEqual([THREAD])
  })

  it('lifts an un-migrated legacy comment into the one-message thread it always was', () => {
    const doc = new LoroDoc()
    seedLegacy(doc, { id: 'c1', x: 10, y: 20, text: 'from before threads' })
    const [thread, ...rest] = readAnnotations(doc)
    expect(rest).toEqual([])
    expect(thread?.id).toBe('c1')
    expect(thread?.anchor).toEqual({ kind: 'spatial', x: 10, y: 20 })
    expect(thread?.messages.map((m) => m.body)).toEqual(['from before threads'])
  })

  it('prefers the thread over a legacy row that shares its id', () => {
    // The migration clears the legacy map, but a replica that merged an old
    // peer's write can hold both. The thread is the newer shape and the one
    // a reply was written into.
    const doc = new LoroDoc()
    writeCommentThread(doc, THREAD)
    seedLegacy(doc, { id: 't1', x: 0, y: 0, text: 'stale' })
    expect(readAnnotations(doc)).toEqual([THREAD])
  })

  it('puts threads before legacy rows, because that order decides bubble placement', () => {
    // `composeComments` fans a later bubble out around an earlier one, so the
    // sequence is behaviour, not presentation. Ids are chosen so that sorting
    // the union would interleave them and change what the canvas draws.
    const doc = new LoroDoc()
    writeCommentThread(doc, { ...THREAD, id: 'z-thread' })
    seedLegacy(doc, { id: 'a-legacy', x: 1, y: 1, text: 'older shape' })
    expect(readAnnotations(doc).map((t) => t.id)).toEqual(['z-thread', 'a-legacy'])
  })

  it('drops a legacy row the schema rejects rather than the rows beside it', () => {
    const doc = new LoroDoc()
    seedLegacy(doc, { id: 'bad', x: 'not a number', text: 'unreadable' })
    seedLegacy(doc, { id: 'good', x: 5, y: 6, text: 'readable' })
    expect(readAnnotations(doc).map((t) => t.id)).toEqual(['good'])
  })
})
