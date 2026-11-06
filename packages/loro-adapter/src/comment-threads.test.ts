import { CANVAS_MAX_NODES, type CommentThread } from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  readCommentThreads,
  setCommentThreadStatus,
  writeCommentThread,
  writeThreadMessage,
} from './comment-threads.js'

const THREAD: CommentThread = {
  id: 't1',
  anchor: { kind: 'spatial', nodeId: 'n1', x: 40, y: 50 },
  status: 'open',
  createdAt: '2026-09-02T00:00:00.000Z',
  messages: [{ id: 'm1', body: 'tighten this', author: 'human:yuki' }],
}

describe('comment threads storage', () => {
  it('round-trips a thread', () => {
    const doc = new LoroDoc()
    writeCommentThread(doc, THREAD)
    expect(readCommentThreads(doc)).toEqual([THREAD])
  })

  it('reads messages in comparator order, not in storage order', () => {
    // Ids ascend while timestamps descend, so neither insertion order nor
    // key order answers this — only the comparator does. A case where the
    // three agree cannot tell whether the read sorts at all.
    const doc = new LoroDoc()
    writeCommentThread(doc, {
      ...THREAD,
      messages: [{ id: 'a', body: 'later', createdAt: '2026-09-02T00:00:00.000Z' }],
    })
    writeThreadMessage(doc, 't1', {
      id: 'b',
      body: 'earlier',
      createdAt: '2026-09-01T00:00:00.000Z',
    })
    expect(readCommentThreads(doc)[0]?.messages.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('rewrites one message without disturbing its siblings, which is how an edit lands', () => {
    const doc = new LoroDoc()
    writeCommentThread(doc, THREAD)
    writeThreadMessage(doc, 't1', { id: 'm2', body: 'reply' })
    writeThreadMessage(doc, 't1', {
      id: 'm1',
      body: 'tightened',
      author: 'human:yuki',
      editedAt: '2026-09-02T01:00:00.000Z',
    })
    const messages = readCommentThreads(doc)[0]?.messages ?? []
    expect(messages.map((m) => m.body).sort()).toEqual(['reply', 'tightened'])
  })

  it('never mints a rival thread container from a reply or a status change', () => {
    // Measured on loro-crdt 1.13.6: when two peers create a container under
    // the same key with no common ancestor, the merge keeps ONE of them and
    // the other side's entries are gone. Creation mints its own id and cannot
    // collide; a reply to a thread this replica has not seen would, so it
    // writes nothing rather than opening a container the other side loses.
    const doc = new LoroDoc()
    writeThreadMessage(doc, 'absent', { id: 'm1', body: 'reply' })
    setCommentThreadStatus(doc, 'absent', 'resolved')
    expect(doc.getMap('threads').keys()).toEqual([])
  })

  it('closes a thread without rewriting its messages', () => {
    const doc = new LoroDoc()
    writeCommentThread(doc, THREAD)
    setCommentThreadStatus(doc, 't1', 'resolved')
    expect(readCommentThreads(doc)).toEqual([{ ...THREAD, status: 'resolved' }])
  })

  it('drops a thread whose stored anchor no longer parses, and keeps its siblings', () => {
    // Same contract as every other read here: a record the schema rejects
    // costs that record, never the ones beside it.
    const doc = new LoroDoc()
    writeCommentThread(doc, THREAD)
    writeCommentThread(doc, { ...THREAD, id: 't2' })
    const broken = doc.getMap('threads').get('t2') as LoroMap
    broken.set('anchor', { kind: 'spatial', x: 1.5, y: 0 })
    doc.commit()
    expect(readCommentThreads(doc).map((t) => t.id)).toEqual(['t1'])
  })

  it('drops a thread stored with a node set past the canvas bound, and keeps its siblings', () => {
    // Stored before the bound, or by a writer that skipped it: every layout
    // would look each id up, so the read costs that thread rather than
    // carrying the cost on, and the document still reads.
    const doc = new LoroDoc()
    writeCommentThread(doc, THREAD)
    writeCommentThread(doc, { ...THREAD, id: 't2' })
    const broken = doc.getMap('threads').get('t2') as LoroMap
    broken.set('anchor', {
      kind: 'spatial',
      nodeIds: Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, i) => `n${i}`),
      x: 0,
      y: 0,
    })
    doc.commit()
    expect(readCommentThreads(doc).map((t) => t.id)).toEqual(['t1'])
  })

  describe('a spatial anchor that is not finite', () => {
    const anchored = (anchor: Record<string, unknown>): CommentThread =>
      ({
        id: 't1',
        anchor: { kind: 'spatial', x: 1, y: 2, ...anchor },
        status: 'open',
        messages: [{ id: 'm1', body: 'hello' }],
      }) as CommentThread

    for (const [field, anchor] of [
      ['x', { x: Number.NaN }],
      ['y', { y: Number.POSITIVE_INFINITY }],
      ['width', { width: Number.NaN, height: 5 }],
      ['height', { width: 5, height: Number.POSITIVE_INFINITY }],
    ] as const) {
      it(`is refused loudly on ${field} instead of storing a thread every reader drops`, () => {
        const doc = new LoroDoc()
        expect(() => writeCommentThread(doc, anchored(anchor))).toThrow(/finite/)
        expect(readCommentThreads(doc)).toEqual([])
      })
    }

    it('is not confused with a finite region, which is stored', () => {
      const doc = new LoroDoc()
      writeCommentThread(doc, anchored({ width: 3, height: 4 }))
      expect(readCommentThreads(doc)).toHaveLength(1)
    })
  })
})
