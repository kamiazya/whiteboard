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
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments } from '../server-deps.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'
import {
  CommentMessageTooLargeError,
  LabelTooLargeError,
  syncWriteAnswer,
} from './sync-write-refusals.js'

/** A cache over a stored snapshot: `evict` drops the instance, `get` rebuilds from what was saved. */
class StoredDoc {
  private stored: Uint8Array
  private cached: LoroDoc | null = null
  saves = 0

  constructor(seed: LoroDoc) {
    this.stored = seed.export({ mode: 'snapshot' })
  }

  get(): LoroDoc {
    if (this.cached === null) this.cached = LoroDoc.fromSnapshot(this.stored)
    return this.cached
  }

  save(doc: LoroDoc): void {
    this.saves += 1
    this.stored = doc.export({ mode: 'snapshot' })
  }

  evict(): void {
    this.cached = null
  }
}

const edge = (label: string): CanvasEdge => ({
  id: 'e1',
  from: { node: 'a' },
  to: { node: 'b' },
  label,
})

function boardSeed(label: string): LoroDoc {
  const doc = new LoroDoc()
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
  return doc
}

function send(store: StoredDoc, edit: (doc: LoroDoc) => void) {
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
    get: async () => store.get(),
    save: async (_workspaceId, _path, doc) => store.save(doc),
    evict: () => store.evict(),
  }
  const client = store.get().fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return applyDocumentUpdate(
    { liveDocuments },
    { workspaceId: 'ws-1', path: 'board', update: client.export({ mode: 'update', from }) },
  )
}

describe('a document sync update', () => {
  it('giving an edge a label past the label limit is refused, 413, and nothing is kept', async () => {
    const store = new StoredDoc(boardSeed('calls'))

    const refusal = await send(store, (doc) =>
      writeSpatialEdge(doc, edge('x'.repeat(LABEL_MAX_CHARS + 1))),
    ).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(LabelTooLargeError)
    expect(refusal).toMatchObject({ elementId: 'e1', chars: LABEL_MAX_CHARS + 1 })
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'label_too_large', status: 413 })
    expect(store.saves).toBe(0)
    expect(readSpatialCanvas(store.get()).edges[0]?.label).toBe('calls')
  })

  it('shortening a label stored past the limit is applied', async () => {
    const stored = 'y'.repeat(LABEL_MAX_CHARS + 10)
    const store = new StoredDoc(boardSeed(stored))

    await send(store, (doc) => writeSpatialEdge(doc, edge(stored.slice(4))))

    expect(readSpatialCanvas(store.get()).edges[0]?.label).toHaveLength(LABEL_MAX_CHARS + 6)
  })

  it('a reply past the message limit is refused, 413, and nothing is kept', async () => {
    const store = new StoredDoc(boardSeed('calls'))

    const refusal = await send(store, (doc) =>
      writeThreadMessage(doc, 't1', { id: 'm2', body: 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS + 1) }),
    ).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(CommentMessageTooLargeError)
    expect(refusal).toMatchObject({ messageId: 'm2', chars: COMMENT_MESSAGE_MAX_CHARS + 1 })
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'comment_too_large', status: 413 })
    expect(store.saves).toBe(0)
    expect(readCommentThreads(store.get())[0]?.messages).toHaveLength(1)
  })
})
