import { compareMessages } from '@kamiazya/whiteboard-model'
import {
  commentMessageArbitrary,
  commentThreadArbitrary,
} from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import {
  readCommentThreads,
  setCommentThreadStatus,
  writeCommentThread,
  writeThreadMessage,
} from './comment-threads.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id))
}

/** Two replicas of the same document, synced up to the write just made. */
function syncedPair(seed: (doc: LoroDoc) => void): [LoroDoc, LoroDoc] {
  const a = new LoroDoc()
  seed(a)
  const b = LoroDoc.fromSnapshot(a.export({ mode: 'snapshot' }))
  return [a, b]
}

function merge(a: LoroDoc, b: LoroDoc): void {
  const fromA = a.export({ mode: 'update' })
  const fromB = b.export({ mode: 'update' })
  a.import(fromB)
  b.import(fromA)
}

describe('comment thread storage properties', () => {
  fcTest.prop([commentThreadArbitrary], withDefaults())(
    'readCommentThreads(writeCommentThread(doc, thread)) deep-equals thread up to message order',
    (thread) => {
      const doc = new LoroDoc()
      writeCommentThread(doc, thread)
      const [stored] = readCommentThreads(doc)
      expect(stored).toBeDefined()
      expect({ ...stored, messages: byId(stored?.messages ?? []) }).toEqual({
        ...thread,
        messages: byId(thread.messages),
      })
    },
  )

  fcTest.prop([commentThreadArbitrary], withDefaults())(
    'a thread reads back with its messages in comparator order',
    (thread) => {
      // The oracle is `compareMessages` applied to the INPUT, never to the
      // output: sorting what came back and asserting it is sorted would pass
      // against a read that does no sorting at all.
      const doc = new LoroDoc()
      writeCommentThread(doc, thread)
      expect(readCommentThreads(doc)[0]?.messages).toEqual(
        [...thread.messages].sort(compareMessages),
      )
    },
  )

  fcTest.prop(
    [commentThreadArbitrary, commentMessageArbitrary, commentMessageArbitrary],
    withDefaults(),
  )(
    'two peers replying to the same thread concurrently both survive the merge',
    (thread, first, second) => {
      // The invariant the whole shape exists for. A thread stored as one
      // whole value would lose one of these replies to last-writer-wins, and
      // the loss is silent: the surviving reply looks like the only one ever
      // written.
      fc.pre(first.id !== second.id)
      fc.pre(!thread.messages.some((m) => m.id === first.id || m.id === second.id))

      const [a, b] = syncedPair((doc) => writeCommentThread(doc, thread))
      writeThreadMessage(a, thread.id, first)
      writeThreadMessage(b, thread.id, second)
      merge(a, b)

      const expected = byId([...thread.messages, first, second])
      for (const replica of [a, b]) {
        const [merged] = readCommentThreads(replica)
        expect(byId(merged?.messages ?? [])).toEqual(expected)
      }
    },
  )

  fcTest.prop([commentThreadArbitrary, commentMessageArbitrary], withDefaults())(
    'a reply and a concurrent resolve do not cancel each other out',
    (thread, reply) => {
      // Resolving is a write to the thread's own field, replying a write to
      // the messages beneath it. Storing the two in one value would make
      // whichever landed second erase the other.
      fc.pre(!thread.messages.some((m) => m.id === reply.id))

      const [a, b] = syncedPair((doc) => writeCommentThread(doc, { ...thread, status: 'open' }))
      writeThreadMessage(a, thread.id, reply)
      setCommentThreadStatus(b, thread.id, 'resolved')
      merge(a, b)

      for (const replica of [a, b]) {
        const [merged] = readCommentThreads(replica)
        expect(merged?.status).toBe('resolved')
        expect(byId(merged?.messages ?? [])).toEqual(byId([...thread.messages, reply]))
      }
    },
  )
})
