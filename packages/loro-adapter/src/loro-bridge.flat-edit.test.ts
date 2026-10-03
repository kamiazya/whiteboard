import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { readCommentThreads, writeCommentThread } from './comment-threads.js'
import { writeCanvasComment } from './loro-bridge.js'

describe('a flat edit of a thread a peer opened', () => {
  test('keeps the opening message id, author and createdAt and changes only the text', () => {
    const doc = new LoroDoc()
    writeCommentThread(doc, {
      id: 'c1',
      anchor: { kind: 'spatial', x: 10, y: 20 },
      status: 'open',
      messages: [
        {
          id: 'peer-msg',
          body: 'original',
          author: 'agent:reviewer',
          createdAt: '2026-09-01T10:00:00+09:00',
        },
      ],
    })
    writeCanvasComment(doc, { id: 'c1', x: 10, y: 20, text: 'edited' })
    const [thread] = readCommentThreads(doc)
    expect(thread?.messages).toHaveLength(1)
    expect(thread?.messages[0]).toMatchObject({
      id: 'peer-msg',
      body: 'edited',
      author: 'agent:reviewer',
      createdAt: '2026-09-01T10:00:00+09:00',
    })
  })

  test('keeps a region anchor the flat projection cannot carry', () => {
    const doc = new LoroDoc()
    writeCommentThread(doc, {
      id: 'c2',
      anchor: { kind: 'spatial', x: 5, y: 6, width: 100, height: 50 },
      status: 'open',
      messages: [{ id: 'm', body: 'region' }],
    })
    writeCanvasComment(doc, { id: 'c2', x: 5, y: 6, text: 'region 2' })
    const [thread] = readCommentThreads(doc)
    expect(thread?.anchor).toMatchObject({ width: 100, height: 50 })
  })
})
