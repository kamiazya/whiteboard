// The comment-conversation state, extracted from SpatialEditor: the compose
// draft, which thread is open, the in-flight pin drag and its settle
// effect, the press-vs-drag disambiguation ref, and the comment-geometry
// helpers every one of those leans on (bubble placement, hit-testing, the
// document's own comment lookup). Called right after use-scene-projection,
// since `commentChromeBoxes` — the boxes the renderer actually painted — is
// its whole hit-testing input.

import type { BoundingBox } from '@kamiazya/whiteboard-canvas-render'
import {
  type CanvasComment,
  type CommentThread,
  canvasCommentsOf,
  isFrame,
  type SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react'
import type { Point } from '../../lib/spatial/viewport.js'
import type { CommentComposeState } from './canvas-commands.js'

export interface CommentStateInputs {
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  /** The canvas as rendered, whose nodes a pin on a node stands at. */
  readonly canvas: SpatialCanvas
  /** The document's conversations; absent, the canvas draws no pin. */
  readonly threads: readonly CommentThread[] | undefined
  readonly commentChromeBoxes: readonly {
    readonly commentId: string
    readonly part: string
    readonly bbox: BoundingBox
  }[]
}

/** How near the committed pin must be to the dropped point to count as there, in canvas units. */
const SETTLE_EPSILON = 1e-6

/**
 * Whether the drawn pin of `commentId` stands at `point`. Near, not equal:
 * the pin's box is laid out around its anchor and read back here, and a
 * node's corner or a point on an edge is fractional, where that round trip
 * is not exact.
 */
function pinStandsAt(
  boxes: CommentStateInputs['commentChromeBoxes'],
  commentId: string,
  point: Point,
): boolean {
  const pin = boxes.find((entry) => entry.commentId === commentId && entry.part === 'pin')
  return (
    pin !== undefined &&
    Math.abs(pin.bbox.x + pin.bbox.w / 2 - point.x) < SETTLE_EPSILON &&
    Math.abs(pin.bbox.y + pin.bbox.h / 2 - point.y) < SETTLE_EPSILON
  )
}

export function useCommentState({
  canvasRef,
  canvas,
  threads,
  commentChromeBoxes,
}: CommentStateInputs) {
  // The pins this canvas draws: the threads' render-time view, the one the
  // layout itself projects, so a press and a menu name what is on screen.
  const comments = useMemo(
    () => canvasCommentsOf(threads ?? [], canvas.nodes),
    [threads, canvas.nodes],
  )
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  /**
   * What a comment's bubble is placed around — the same obstacle set
   * canvas-render's placer sees for it: every node that is not a group
   * frame, plus the bubbles of the comments BEFORE it in document order
   * (all of them for a comment about to be created, which goes last). The
   * editor's draft and its drag preview both place through this, so a
   * bubble opens, drags and settles in one spot.
   */
  const commentPlacementObstacles = (beforeCommentId?: string): BoundingBox[] => {
    const out: BoundingBox[] = canvasRef.current.nodes
      .filter((node) => !isFrame(node))
      .map((node) => ({ x: node.x, y: node.y, w: node.width, h: node.height }))
    for (const entry of commentChromeBoxes) {
      if (entry.part !== 'bubble') continue
      if (entry.commentId === beforeCommentId) break
      out.push(entry.bbox)
    }
    return out
  }
  const hitTestComment = (point: Point): string | undefined => {
    for (let i = commentChromeBoxes.length - 1; i >= 0; i -= 1) {
      const entry = commentChromeBoxes[i]
      if (entry === undefined) continue
      const { bbox } = entry
      if (
        point.x >= bbox.x &&
        point.x <= bbox.x + bbox.w &&
        point.y >= bbox.y &&
        point.y <= bbox.y + bbox.h
      ) {
        return entry.commentId
      }
    }
    return undefined
  }
  const commentById = (id: string): CanvasComment | undefined =>
    commentsRef.current.find((entry) => entry.id === id)
  /**
   * Opens a conversation in place, or shuts the one already open. Pressing
   * the comment whose card is up is how it closes without hunting for the
   * ×, which is the gesture people try first.
   */
  const toggleCommentCard = (commentId: string): void => {
    setOpenCommentId((current) => (current === commentId ? null : commentId))
  }
  const [commentCompose, setCommentCompose] = useState<CommentComposeState | null>(null)
  /**
   * The conversation opened in place on the canvas — at most one, because
   * a card is a place to read and answer ONE thread, and a canvas of
   * simultaneously open cards is the comments rail with worse layout.
   */
  const [openCommentId, setOpenCommentId] = useState<string | null>(null)
  /**
   * The comment a press landed on, read back at the release. A press that
   * never travelled opens the card; one that travelled became a pin drag at
   * its first move and the drag branch owns it.
   *
   * The press arms NOTHING visible. Arming the drag here — which takes the
   * committed copy out of the surface for the preview — removed the very
   * element a finger's pointer is implicitly captured on, so the release
   * was delivered to a detached node and never reached the root. The
   * stale press and drag then replayed on every later tap: a tap on the
   * canvas re-opened the card the tap had just shut, and a tap on the
   * card's reply box moved the comment instead of focusing the box. A
   * mouse never showed it, since an uncaptured release is hit-tested at
   * the release. So the surface is left alone until the pointer travels.
   */
  const pressedCommentRef = useRef<{
    readonly comment: CanvasComment
    readonly startScreen: Point
    readonly startPoint: Point
  } | null>(null)
  /**
   * A pin being dragged: the comment DETACHED and standing where its pin
   * was drawn at the press, the press point, and the live pointer. Kept beside the gesture machine rather than in it — see
   * CommentDragLayer for why — so the node machinery (snapping, carried
   * sets, live edges) never has to learn what a comment is.
   */
  const [commentDrag, setCommentDrag] = useState<{
    readonly comment: CanvasComment
    readonly startPoint: Point
    readonly live: Point | null
    /** The obstacle set at the press, so the preview places like the committed chrome. */
    readonly obstacles: readonly BoundingBox[]
    /**
     * Set on release: where the layer will draw the pin once the move is
     * committed — a node's corner, a point on an edge, or the dropped point.
     * The drag then SETTLES rather than ending — the preview stays up, and
     * the committed copy stays out of the surface, until the committed scene
     * carries the pin here (a worker round trip later on a large canvas).
     * Ending at the release instead showed the old copy for a frame and
     * animated it to the new anchor.
     */
    readonly dropped: Point | null
  } | null>(null)
  useEffect(() => {
    if (commentDrag?.dropped == null) return
    const arrived = pinStandsAt(commentChromeBoxes, commentDrag.comment.id, commentDrag.dropped)
    // Gone (removed underneath the drag) settles too: nothing to wait for.
    if (arrived || commentById(commentDrag.comment.id) === undefined) setCommentDrag(null)
  }, [commentDrag, commentChromeBoxes])

  return {
    comments,
    commentPlacementObstacles,
    hitTestComment,
    commentById,
    toggleCommentCard,
    commentCompose,
    setCommentCompose,
    openCommentId,
    setOpenCommentId,
    pressedCommentRef,
    commentDrag,
    setCommentDrag,
  }
}
