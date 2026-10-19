import { commentMessageSchema, commentThreadSchema } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCommentThreads, writeThreadMessage } from './comment-threads.js'
import {
  readSpatialCanvas,
  reconcileSpatialCanvas,
  withSpatialBatch,
  writeSpatialCanvas,
} from './loro-bridge.js'

const THREADS = 200
const REPLIES = 3
const FLIPS = 200

function seeded(): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n', text: 'n', x: 0, y: 0, width: 10, height: 10 })],
    edges: [],
    comments: Array.from({ length: THREADS }, (_, i) => ({
      id: `c${String(i).padStart(4, '0')}`,
      x: i,
      y: 0,
      text: `comment ${i}`,
    })),
  })
  for (let i = 0; i < THREADS; i += 1) {
    for (let r = 0; r < REPLIES; r += 1) {
      writeThreadMessage(doc, `c${String(i).padStart(4, '0')}`, { id: `r${r}`, body: `reply ${r}` })
    }
  }
  return doc
}

/** Counts thread and message schema parses, and map key materialisations, the body causes. */
function counting(body: () => void): {
  threadParses: number
  messageParses: number
  keyReads: number
} {
  const thread = vi.spyOn(commentThreadSchema, 'safeParse')
  const message = vi.spyOn(commentMessageSchema, 'safeParse')
  const keys = vi.spyOn(LoroMap.prototype, 'keys')
  body()
  return {
    threadParses: thread.mock.calls.length,
    messageParses: message.mock.calls.length,
    keyReads: keys.mock.calls.length,
  }
}

function expectResolvedWithRepliesKept(doc: LoroDoc): void {
  const threads = readCommentThreads(doc)
  expect(threads).toHaveLength(THREADS)
  expect(threads.slice(0, FLIPS).every((thread) => thread.status === 'resolved')).toBe(true)
  expect(threads.every((thread) => thread.messages.length === REPLIES + 1)).toBe(true)
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Rewriting a comment needs the ONE thread it rewrites. Reading the whole
 * plane for each was C x (T + M) schema parses for C changed comments.
 */
describe('a comment rewrite reads only the thread it rewrites', () => {
  it('resolving many comments in one reconcile reads each changed thread once', () => {
    const doc = seeded()
    const prev = readSpatialCanvas(doc)
    const comments = (prev.comments ?? []).map((comment, i) =>
      i < FLIPS ? { ...comment, resolved: true } : comment,
    )

    const counts = counting(() => reconcileSpatialCanvas(doc, prev, { ...prev, comments }))

    expectResolvedWithRepliesKept(doc)
    expect(counts.threadParses).toBeGreaterThan(0)
    expect(counts.threadParses).toBeLessThanOrEqual(FLIPS)
    expect(counts.messageParses).toBeLessThanOrEqual(FLIPS * (REPLIES + 1))
    expect(counts.keyReads).toBeLessThanOrEqual(FLIPS + 4)
  })

  it('resolving many comments in one batch reads each changed thread once', () => {
    const doc = seeded()
    const prev = readSpatialCanvas(doc)

    const counts = counting(() =>
      withSpatialBatch(doc, (writer) => {
        for (const comment of (prev.comments ?? []).slice(0, FLIPS)) {
          writer.writeComment({ ...comment, resolved: true })
        }
      }),
    )

    expectResolvedWithRepliesKept(doc)
    expect(counts.threadParses).toBeGreaterThan(0)
    expect(counts.threadParses).toBeLessThanOrEqual(FLIPS)
    expect(counts.messageParses).toBeLessThanOrEqual(FLIPS * (REPLIES + 1))
    expect(counts.keyReads).toBeLessThanOrEqual(FLIPS + 4)
  })
})
