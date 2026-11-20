/**
 * The conformance cases for the stored message count of each thread, which a
 * ceiling on a thread's messages is judged from: it counts what is STORED, so a
 * thread the schema refuses to read still has its messages counted.
 */
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import { ask, FIRST, write } from './crdt-engine-conformance-kit.js'

const thread = (id: string, anchor: object) => ({
  id,
  anchor,
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  messages: [{ id: `${id}-m1`, body: 'first', createdAt: '2026-01-01T00:00:00.000Z' }],
})

const READABLE = { kind: 'document' }
// An anchor no schema admits: the thread is stored and no read of threads shows it.
const UNREADABLE = { kind: 'no-such-anchor' }

const reply = (threadId: string, n: number) => ({
  threadId,
  message: { id: `${threadId}-m${n}`, body: 'more', createdAt: '2026-01-01T00:00:00.000Z' },
})

function open(engine: CrdtEngine) {
  return engine.open({ peer: '1' }).handle
}

export function describeThreadMessageCounts(makeEngine: () => CrdtEngine) {
  describe('the stored message count of each thread', () => {
    it('answers nothing for a document without threads', async () => {
      const engine = makeEngine()
      expect(await ask(engine, open(engine), 'threadMessageCounts')).toEqual({ ok: {} })
    })

    it('counts every message a thread stores, readable thread or not', async () => {
      const engine = makeEngine()
      const handle = open(engine)
      write(engine, handle, 'writeCommentThread', { thread: thread('t1', READABLE) })
      write(engine, handle, 'writeThreadMessage', reply('t1', 2))
      write(engine, handle, 'writeThreadMessage', reply('t1', 3))
      write(engine, handle, 'writeCommentThread', { thread: thread('hidden', UNREADABLE) })
      write(engine, handle, 'writeThreadMessage', reply('hidden', 2))
      expect(await ask(engine, handle, 'threadMessageCounts')).toEqual({
        ok: { t1: 3, hidden: 2 },
      })
      const threads = (await ask(engine, handle, 'commentThreads')) as { ok: { id: string }[] }
      expect(threads.ok.map((held) => held.id)).toEqual(['t1'])
    })

    it('answers for the document a workspace record hosts, and refuses one it does not', async () => {
      const engine = makeEngine()
      const handle = open(engine)
      write(engine, handle, 'createWorkspaceDocumentAtPath', {
        path: 'note',
        documentId: FIRST,
        kind: 'markdown',
      })
      write(engine, handle, 'writeCommentThread', {
        documentId: FIRST,
        thread: thread('t1', READABLE),
      })
      expect(await ask(engine, handle, 'threadMessageCounts', { documentId: FIRST })).toEqual({
        ok: { t1: 1 },
      })
      const other = await ask(engine, handle, 'threadMessageCounts', {
        documentId: '01J0000000000000000000000Z',
      })
      expect(other).toHaveProperty('err')
    })
  })
}
