/**
 * The comment geometry the editor's pointer claims lean on: which comment a
 * press lands on, what a bubble is placed around, and how pressing an open
 * conversation shuts it. Asked of the hook directly — its inputs are the
 * painted chrome boxes and the canvas, both plain data — so each answer is
 * pinned without a renderer in the way.
 */
import type { BoundingBox } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useCommentState } from './use-comment-state.js'

type ChromeBox = { commentId: string; part: string; bbox: BoundingBox }

function commentState(canvas: SpatialCanvas, commentChromeBoxes: readonly ChromeBox[]) {
  return renderHook(() => useCommentState({ canvasRef: { current: canvas }, commentChromeBoxes }))
}

const EMPTY: SpatialCanvas = { nodes: [], edges: [] }

describe('useCommentState', () => {
  it('a press where two bubbles overlap lands on the one painted on top', () => {
    // Painted in list order, so the later box is the one on top.
    const { result } = commentState(EMPTY, [
      { commentId: 'under', part: 'bubble', bbox: { x: 0, y: 0, w: 100, h: 60 } },
      { commentId: 'over', part: 'bubble', bbox: { x: 50, y: 30, w: 100, h: 60 } },
    ])

    expect(result.current.hitTestComment({ x: 75, y: 45 })).toBe('over')
    expect(result.current.hitTestComment({ x: 10, y: 10 })).toBe('under')
    expect(result.current.hitTestComment({ x: 300, y: 300 })).toBeUndefined()
  })

  it('places a bubble around content nodes but not around a frame that holds them', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        groupNode({ id: 'frame', x: 0, y: 0, width: 400, height: 300, label: 'Area' }),
        textNode({ id: 'card', x: 20, y: 20, width: 80, height: 40, text: 'inside' }),
      ],
      edges: [],
    }
    const { result } = commentState(canvas, [])

    expect(result.current.commentPlacementObstacles()).toEqual([{ x: 20, y: 20, w: 80, h: 40 }])
  })

  it('places a bubble around the bubbles before it, never its own or later ones', () => {
    const first = { x: 0, y: 0, w: 40, h: 20 }
    const own = { x: 100, y: 0, w: 40, h: 20 }
    const later = { x: 200, y: 0, w: 40, h: 20 }
    const { result } = commentState(EMPTY, [
      { commentId: 'first', part: 'pin', bbox: { x: -10, y: -10, w: 8, h: 8 } },
      { commentId: 'first', part: 'bubble', bbox: first },
      { commentId: 'own', part: 'bubble', bbox: own },
      { commentId: 'later', part: 'bubble', bbox: later },
    ])

    expect(result.current.commentPlacementObstacles('own')).toEqual([first])
    // A comment about to be created goes last, so every bubble is in its way.
    expect(result.current.commentPlacementObstacles()).toEqual([first, own, later])
  })

  it('pressing the comment whose card is open shuts it; pressing another switches', () => {
    const { result } = commentState(EMPTY, [])

    act(() => result.current.toggleCommentCard('a'))
    expect(result.current.openCommentId).toBe('a')
    act(() => result.current.toggleCommentCard('b'))
    expect(result.current.openCommentId).toBe('b')
    act(() => result.current.toggleCommentCard('b'))
    expect(result.current.openCommentId).toBeNull()
  })
})
