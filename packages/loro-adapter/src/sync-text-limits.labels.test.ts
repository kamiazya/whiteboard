import {
  COMMENT_MESSAGE_MAX_CHARS,
  LABEL_MAX_CHARS,
  type SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeCommentThread, writeThreadMessage } from './comment-threads.js'
import type { DocumentContainers } from './containers.js'
import { writeSpatialCanvas, writeSpatialEdge, writeSpatialNode } from './loro-bridge.js'
import { importWithinTextLimits, syncTextLimitBreach } from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

const box = (id: string, x: number) => textNode({ id, x, y: 0, width: 100, height: 60, text: id })

/** A workspace record holding one board: two boxes, a relation, a stroke, a frame and a thread. */
function record(labels: { edge?: string; group?: string; message?: string } = {}): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: DOC_ID, kind: 'spatial' })
  const board = documentContainers(doc, DOC_ID)
  const canvas: SpatialCanvas = {
    nodes: [
      box('a', 0),
      box('b', 300),
      groupNode({ id: 'g', x: 0, y: 200, width: 400, height: 200, label: labels.group ?? 'frame' }),
    ],
    edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, label: labels.edge ?? 'calls' }],
    lines: [
      {
        id: 'l',
        from: { kind: 'point', point: { x: 0, y: 500 } },
        to: { kind: 'point', point: { x: 300, y: 500 } },
        label: 'ink',
      },
    ],
  }
  writeSpatialCanvas(board, canvas)
  writeCommentThread(board, {
    id: 't',
    anchor: { kind: 'document' },
    status: 'open',
    messages: [{ id: 'm1', body: labels.message ?? 'looks off' }],
  })
  doc.commit()
  return doc
}

function updateFrom(base: LoroDoc, edit: (board: DocumentContainers) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(documentContainers(client, DOC_ID))
  client.commit()
  return client.export({ mode: 'update', from })
}

/** Both keepers' verdicts, which must agree. */
function judged(base: LoroDoc, update: Uint8Array) {
  const imported = importWithinTextLimits(base.fork(), update).breach
  expect(syncTextLimitBreach(base, update)).toEqual(imported)
  return imported
}

const over = (max: number) => 'x'.repeat(max + 1)

describe('a label written through a sync update', () => {
  it('refuses a relation label past the label limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      writeSpatialEdge(board, {
        id: 'e',
        from: { node: 'a' },
        to: { node: 'b' },
        label: over(LABEL_MAX_CHARS),
      }),
    )
    expect(judged(base, update)).toEqual({
      shape: 'label',
      chars: LABEL_MAX_CHARS + 1,
      elementId: 'e',
    })
  })

  it('refuses a frame label past the label limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      writeSpatialNode(
        board,
        groupNode({ id: 'g', x: 0, y: 200, width: 400, height: 200, label: over(LABEL_MAX_CHARS) }),
      ),
    )
    expect(judged(base, update)).toMatchObject({ shape: 'label', elementId: 'g' })
  })

  it('refuses a stroke label past the label limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      board.getMap('lines').set('l', {
        id: 'l',
        from: { kind: 'point', point: { x: 0, y: 500 } },
        to: { kind: 'point', point: { x: 300, y: 500 } },
        label: over(LABEL_MAX_CHARS),
      }),
    )
    expect(judged(base, update)).toMatchObject({ shape: 'label', elementId: 'l' })
  })

  it('takes a label of exactly the limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      writeSpatialEdge(board, {
        id: 'e',
        from: { node: 'a' },
        to: { node: 'b' },
        label: 'x'.repeat(LABEL_MAX_CHARS),
      }),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('takes an edit of a label stored past the limit that does not grow it', () => {
    const stored = 'y'.repeat(LABEL_MAX_CHARS + 10)
    const base = record({ edge: stored })
    const update = updateFrom(base, (board) =>
      writeSpatialEdge(board, {
        id: 'e',
        from: { node: 'a' },
        to: { node: 'b' },
        color: '1',
        label: stored.slice(3),
      }),
    )
    expect(judged(base, update)).toBeNull()
  })
})

describe('a comment message written through a sync update', () => {
  it('refuses a reply past the message limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      writeThreadMessage(board, 't', { id: 'm2', body: over(COMMENT_MESSAGE_MAX_CHARS) }),
    )
    expect(judged(base, update)).toEqual({
      shape: 'comment-message',
      chars: COMMENT_MESSAGE_MAX_CHARS + 1,
      messageId: 'm2',
    })
  })

  it('refuses a new thread whose opening message is past the limit', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      writeCommentThread(board, {
        id: 't2',
        anchor: { kind: 'document' },
        status: 'open',
        messages: [{ id: 'm9', body: over(COMMENT_MESSAGE_MAX_CHARS) }],
      }),
    )
    expect(judged(base, update)).toMatchObject({ shape: 'comment-message', messageId: 'm9' })
  })

  it('takes an edit of a message stored past the limit that shortens it', () => {
    const stored = 'y'.repeat(COMMENT_MESSAGE_MAX_CHARS + 10)
    const base = record({ message: stored })
    const update = updateFrom(base, (board) =>
      writeThreadMessage(board, 't', { id: 'm1', body: stored.slice(1) }),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('refuses a message past the limit that a record holds into an empty document', () => {
    const long = record({ message: over(COMMENT_MESSAGE_MAX_CHARS) })
    expect(
      importWithinTextLimits(new LoroDoc(), long.export({ mode: 'snapshot' })).breach,
    ).toMatchObject({ shape: 'comment-message', messageId: 'm1' })
  })
})
