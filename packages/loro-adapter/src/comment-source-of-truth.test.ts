/**
 * The annotation layer is a plane BESIDE the canvas (ADR-0026 decision 1): a
 * canvas read does not carry it and no canvas write reaches it. The threads
 * plane is written by the thread writers alone, so a whole-canvas resync, a
 * reconcile or a batch can never close, move or delete a conversation.
 */

import type { CommentThread } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { moveCommentThread, readCommentThreads, writeCommentThread } from './comment-threads.js'
import {
  readSpatialCanvas,
  reconcileSpatialCanvas,
  withSpatialBatch,
  writeSpatialCanvas,
} from './loro-bridge.js'

const NODE = textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 40, text: 'hello' })

const THREAD: CommentThread = {
  id: 't1',
  anchor: { kind: 'spatial', x: 40, y: 50, nodeId: 'n1' },
  status: 'open',
  messages: [{ id: 't1-m1', body: 'tighten this', author: 'human:yuki' }],
}

function seeded(): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [NODE], edges: [] })
  writeCommentThread(doc, THREAD)
  return doc
}

describe('the canvas does not carry the annotation layer', () => {
  it('reads a canvas with no comments, whatever threads the document holds', () => {
    expect(readSpatialCanvas(seeded())).toEqual({ nodes: [NODE], edges: [] })
  })

  it('leaves every thread alone on a resync that states the whole canvas', () => {
    const doc = seeded()
    writeSpatialCanvas(doc, { nodes: [], edges: [] })
    expect(readCommentThreads(doc)).toEqual([THREAD])
  })

  it('leaves every thread alone on a reconcile and on a batch', () => {
    const doc = seeded()
    const prev = readSpatialCanvas(doc)
    reconcileSpatialCanvas(doc, prev, { nodes: [], edges: [] })
    withSpatialBatch(doc, (writer) => writer.writeNode({ ...NODE, id: 'n2' }))
    expect(readCommentThreads(doc)).toEqual([THREAD])
  })
})

describe('moveCommentThread', () => {
  it('re-anchors a pin to the node it is dropped on, keeping its messages and its status', () => {
    const doc = seeded()
    expect(moveCommentThread(doc, 't1', { x: 7, y: 8, nodeId: 'n2' })).toBe(true)
    expect(readCommentThreads(doc)).toEqual([
      { ...THREAD, anchor: { kind: 'spatial', x: 7, y: 8, nodeId: 'n2' } },
    ])
  })

  it('makes a pin dropped on nothing a point', () => {
    const doc = seeded()
    expect(moveCommentThread(doc, 't1', { x: 7, y: 8 })).toBe(true)
    expect(readCommentThreads(doc)).toEqual([
      { ...THREAD, anchor: { kind: 'spatial', x: 7, y: 8 } },
    ])
  })

  it('leaves a region where it is: its pin stands at a corner no drag can move', () => {
    const doc = new LoroDoc()
    const region: CommentThread = {
      ...THREAD,
      anchor: { kind: 'spatial', x: 0, y: 0, width: 50, height: 50 },
    }
    writeCommentThread(doc, region)
    const before = doc.version().toJSON()
    expect(moveCommentThread(doc, 't1', { x: 7, y: 8 })).toBe(false)
    expect(doc.version().toJSON()).toEqual(before)
  })

  it('writes nothing for a thread this replica does not hold', () => {
    const doc = seeded()
    const before = doc.version().toJSON()
    expect(moveCommentThread(doc, 'ghost', { x: 0, y: 0 })).toBe(false)
    expect(doc.version().toJSON()).toEqual(before)
  })

  it('refuses a non-finite point before anything is stored', () => {
    const doc = seeded()
    expect(() => moveCommentThread(doc, 't1', { x: Number.NaN, y: 0 })).toThrow(/non-finite x/)
    expect(readCommentThreads(doc)).toEqual([THREAD])
  })
})
