// @vitest-environment node
import type { CanvasComment } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import { commentMenuItems } from './comment-menu-items.js'

const labelOf = (item: { label?: string; kind?: string }) => item.label ?? item.kind

describe('commentMenuItems', () => {
  it("offers only the conversation's own lifecycle, none of the canvas verbs", () => {
    const comment: CanvasComment = { id: 'c1', x: 10, y: 20, text: 'note' }
    const items = commentMenuItems({ comment, applyResult: vi.fn() })
    // No Edit row since 2026-09-08: it opened a pre-filled bubble that
    // could only rewrite the opening message, because what it wrote was the
    // flat comment's `text`. Editing moved onto the message, in the card,
    // where it can name WHICH message.
    expect(items.map(labelOf)).toEqual(['Resolve'])
  })

  it('a resolved comment offers Reopen instead, and either verb writes set-comment-resolved', () => {
    const applyResult = vi.fn()
    const resolved: CanvasComment = { id: 'c1', x: 10, y: 20, text: 'note', resolved: true }
    const items = commentMenuItems({ comment: resolved, applyResult })
    expect(items.map(labelOf)).toEqual(['Reopen'])
    ;(items[0] as { onSelect: () => void }).onSelect()
    expect(applyResult).toHaveBeenCalledWith({
      state: { kind: 'idle' },
      commands: [{ kind: 'set-comment-resolved', id: 'c1', resolved: false }],
    })
  })
})
