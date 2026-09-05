/**
 * What happens when two replicas open the SAME thread container first.
 *
 * A thread's key is not minted by the writer — it is the caller's comment id
 * (`writeCommentInto` passes it straight through, and `deleteCommentInto`
 * looks the thread up by it). So two keepers can genuinely reach
 * `writeThreadInto` with the same key having never seen each other's: the
 * daemon and this browser's replica each running
 * `migrateCanvasCommentsToThreads` over the same legacy comment, or each
 * applying a `comment.add` for one id.
 *
 * Under `getOrCreateContainer` that is silent loss. Measured on loro-crdt
 * 1.13.6: two peers writing distinct entries into a container they each
 * created at one key converge on ONE of the two containers, and the other
 * side's entries are gone — no conflict, no error, and both replicas agree
 * on the truncated result, which is what makes it unfindable afterwards.
 */

import type { CommentThread } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readCommentThreads, writeCommentThread } from './comment-threads.js'

const ANCHOR = { kind: 'spatial', nodeId: 'n1', x: 10, y: 20 } as const

function threadFrom(messageId: string, body: string): CommentThread {
  return { id: 'shared-id', anchor: ANCHOR, status: 'open', messages: [{ id: messageId, body }] }
}

/** Two replicas that have never seen the key, each writing the same thread. */
function replicasThatBothOpenTheThread(): { a: LoroDoc; b: LoroDoc } {
  const a = new LoroDoc()
  a.setPeerId(1)
  const b = new LoroDoc()
  b.setPeerId(2)
  // A common ancestor that does NOT contain the thread, so neither side is
  // merely writing into a container the other already made.
  a.getMap('nodes').set('n1', { id: 'n1' })
  a.commit()
  b.import(a.export({ mode: 'snapshot' }))

  writeCommentThread(a, threadFrom('m-a', 'from the daemon'))
  writeCommentThread(b, threadFrom('m-b', 'from the browser'))

  a.import(b.export({ mode: 'update' }))
  b.import(a.export({ mode: 'update' }))
  return { a, b }
}

describe('two replicas opening one thread container', () => {
  it('keeps both sides messages instead of hiding one behind the other', () => {
    const { a } = replicasThatBothOpenTheThread()

    const bodies = readCommentThreads(a).flatMap((t) => t.messages.map((m) => m.body))

    expect(bodies.sort()).toEqual(['from the browser', 'from the daemon'])
  })

  it('converges: both replicas read the same thing', () => {
    const { a, b } = replicasThatBothOpenTheThread()

    expect(readCommentThreads(a)).toEqual(readCommentThreads(b))
  })
})
