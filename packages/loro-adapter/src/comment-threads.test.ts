import type { CommentThread } from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  migrateCanvasCommentsToThreads,
  readCommentThreads,
  setCommentThreadStatus,
  writeCommentThread,
  writeThreadMessage,
} from './comment-threads.js'
import { writeCanvasComment } from './loro-bridge.js'

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
})

describe('migrateCanvasCommentsToThreads', () => {
  it('turns each stored comment into a one-message thread', () => {
    const doc = new LoroDoc()
    writeCanvasComment(doc, {
      id: 'c1',
      x: 1,
      y: 2,
      text: 'tighten this',
      targetNodeId: 'n1',
      resolved: true,
    })
    expect(migrateCanvasCommentsToThreads(doc)).toBe(1)
    expect(readCommentThreads(doc)).toEqual([
      {
        id: 'c1',
        anchor: { kind: 'spatial', nodeId: 'n1', x: 1, y: 2 },
        status: 'resolved',
        messages: [{ id: 'c1', body: 'tighten this' }],
      },
    ])
  })

  it('leaves the comments plane in place, because its readers have not moved yet', () => {
    const doc = new LoroDoc()
    writeCanvasComment(doc, { id: 'c1', x: 1, y: 2, text: 'x' })
    migrateCanvasCommentsToThreads(doc)
    expect(doc.getMap('comments').keys()).toEqual(['c1'])
  })

  it('is idempotent, and a second pass does not clobber a reply added since', () => {
    const doc = new LoroDoc()
    writeCanvasComment(doc, { id: 'c1', x: 1, y: 2, text: 'x' })
    migrateCanvasCommentsToThreads(doc)
    writeThreadMessage(doc, 'c1', { id: 'm2', body: 'reply' })
    expect(migrateCanvasCommentsToThreads(doc)).toBe(0)
    expect(readCommentThreads(doc)[0]?.messages).toHaveLength(2)
  })

  it('skips a comment the schema rejects rather than failing the whole pass', () => {
    const doc = new LoroDoc()
    writeCanvasComment(doc, { id: 'c1', x: 1, y: 2, text: 'x' })
    doc.getMap('comments').set('bad', { id: 'bad', x: 0, y: 0 })
    doc.commit()
    expect(migrateCanvasCommentsToThreads(doc)).toBe(1)
    expect(readCommentThreads(doc).map((t) => t.id)).toEqual(['c1'])
  })
})
