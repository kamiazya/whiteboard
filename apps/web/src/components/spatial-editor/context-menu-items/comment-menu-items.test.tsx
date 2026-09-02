import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import { commentMenuItems } from './comment-menu-items.js'

const canvas: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
}
const labelOf = (item: { label?: string; kind?: string }) => item.label ?? item.kind

describe('commentMenuItems', () => {
  it("offers only the comment's own verbs, none of the canvas ones", () => {
    const comment: CanvasComment = { id: 'c1', x: 10, y: 20, text: 'note' }
    const items = commentMenuItems({
      comment,
      canvasRef: { current: canvas },
      setCommentCompose: vi.fn(),
      applyResult: vi.fn(),
    })
    expect(items.map(labelOf)).toEqual(['Edit comment', 'Resolve'])
  })

  it('"Edit comment" opens the compose at the comment\'s drawn anchor, pre-filled', () => {
    const setCommentCompose = vi.fn()
    // Node-anchored: the anchor is the node\'s top-right corner, not the stored x/y.
    const comment: CanvasComment = { id: 'c1', x: 0, y: 0, text: 'note', targetNodeId: 'n1' }
    const items = commentMenuItems({
      comment,
      canvasRef: { current: canvas },
      setCommentCompose,
      applyResult: vi.fn(),
    })
    ;(items[0] as { onSelect: () => void }).onSelect()
    expect(setCommentCompose).toHaveBeenCalledWith({
      point: { x: 300, y: 100 },
      editing: { id: 'c1', initialText: 'note' },
    })
  })

  it('a resolved comment offers Reopen instead, and either verb writes set-comment-resolved', () => {
    const applyResult = vi.fn()
    const resolved: CanvasComment = { id: 'c1', x: 10, y: 20, text: 'note', resolved: true }
    const items = commentMenuItems({
      comment: resolved,
      canvasRef: { current: canvas },
      setCommentCompose: vi.fn(),
      applyResult,
    })
    expect(items.map(labelOf)).toEqual(['Edit comment', 'Reopen'])
    ;(items[1] as { onSelect: () => void }).onSelect()
    expect(applyResult).toHaveBeenCalledWith({
      state: { kind: 'idle' },
      commands: [{ kind: 'set-comment-resolved', id: 'c1', resolved: false }],
    })
  })
})
