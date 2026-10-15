// @vitest-environment node

import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands.js'

// The pin is the canvas's projection of a thread: it draws the opening
// message and the thread's resolved flag, and nothing else of the
// conversation. These pin the EFFECT on that projection, not the flag a
// command carries.
describe('a thread command reaching its pin', () => {
  const PIN: CanvasComment = { id: 't1', x: 10, y: 20, text: 'opening', resolved: true }
  const pinned = (): SpatialCanvas => ({ nodes: [], edges: [], comments: [PIN] })
  const pinOf = (canvas: SpatialCanvas) => canvas.comments?.find((c) => c.id === 't1')

  it('reopening the thread clears the pin flag', () => {
    const next = applyCommand(pinned(), {
      kind: 'set-thread-status',
      threadId: 't1',
      status: 'open',
    })
    expect(pinOf(next)?.resolved).toBe(false)
  })

  it('editing a reply leaves the drawn opening text alone', () => {
    const canvas = pinned()
    const next = applyCommand(canvas, {
      kind: 'edit-thread-message',
      threadId: 't1',
      message: { id: 'm2', body: 'a reply' },
      opening: false,
    })
    expect(pinOf(next)?.text).toBe('opening')
    expect(next).toBe(canvas)
  })

  it('editing the opening message rewrites the drawn text', () => {
    const next = applyCommand(pinned(), {
      kind: 'edit-thread-message',
      threadId: 't1',
      message: { id: 'm1', body: 'rewritten' },
      opening: true,
    })
    expect(pinOf(next)).toEqual({ ...PIN, text: 'rewritten' })
  })
})
