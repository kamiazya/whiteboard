/**
 * The label and comment-message bounds on the editor's sync writes.
 *
 * The tools refuse a label past `LABEL_MAX_CHARS` and a message past
 * `COMMENT_MESSAGE_MAX_CHARS` through their schemas; a sync write carries Loro
 * bytes no schema reads, so the bound is judged against what the bytes DO.
 * The double keeps a stored snapshot beside its cached instance, so "nothing
 * was kept" is observable as what the next read finds.
 */
import {
  type DocumentContainers,
  readCommentThreads,
  readSpatialCanvas,
  writeCommentThread,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  type CanvasEdge,
  COMMENT_MESSAGE_MAX_CHARS,
  LABEL_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { contentOf, recordHolding, sendRecordEdit as send } from '../test-utils/record-sync.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { syncWriteAnswer } from './sync-write-refusals.js'

const edge = (label: string): CanvasEdge => ({
  id: 'e1',
  from: { node: 'a' },
  to: { node: 'b' },
  label,
})

function boardSeed(label: string): LoroDoc {
  return recordHolding((doc) => seedBoard(doc, label))
}

function seedBoard(doc: DocumentContainers, label: string): void {
  writeSpatialCanvas(doc, {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'a' }),
      textNode({ id: 'b', x: 300, y: 0, width: 100, height: 60, text: 'b' }),
    ],
    edges: [edge(label)],
  })
  writeCommentThread(doc, {
    id: 't1',
    anchor: { kind: 'document' },
    status: 'open',
    messages: [{ id: 'm1', body: 'looks off' }],
  })
}

describe('a workspace-record sync update', () => {
  it('giving an edge a label past the label limit is refused, 413, and nothing is kept', async () => {
    const store = new StoredDoc(boardSeed('calls'))

    const refusal = await send(store, (doc) =>
      writeSpatialEdge(doc, edge('x'.repeat(LABEL_MAX_CHARS + 1))),
    ).catch((err: unknown) => err)

    expect(refusal).toMatchObject({ name: 'LabelTooLargeError' })
    expect(refusal).toMatchObject({ breach: { elementId: 'e1', chars: LABEL_MAX_CHARS + 1 } })
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'label_too_large', status: 413 })
    expect(store.saves).toBe(0)
    expect(readSpatialCanvas(contentOf(store.get())).edges[0]?.label).toBe('calls')
  })

  it('shortening a label stored past the limit is applied', async () => {
    const stored = 'y'.repeat(LABEL_MAX_CHARS + 10)
    const store = new StoredDoc(boardSeed(stored))

    await send(store, (doc) => writeSpatialEdge(doc, edge(stored.slice(4))))

    expect(readSpatialCanvas(contentOf(store.get())).edges[0]?.label).toHaveLength(
      LABEL_MAX_CHARS + 6,
    )
  })

  it('a reply past the message limit is refused, 413, and nothing is kept', async () => {
    const store = new StoredDoc(boardSeed('calls'))

    const refusal = await send(store, (doc) =>
      writeThreadMessage(doc, 't1', { id: 'm2', body: 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS + 1) }),
    ).catch((err: unknown) => err)

    expect(refusal).toMatchObject({ name: 'CommentMessageTooLargeError' })
    expect(refusal).toMatchObject({
      breach: { messageId: 'm2', chars: COMMENT_MESSAGE_MAX_CHARS + 1 },
    })
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'comment_too_large', status: 413 })
    expect(store.saves).toBe(0)
    expect(readCommentThreads(contentOf(store.get()))[0]?.messages).toHaveLength(1)
  })
})
