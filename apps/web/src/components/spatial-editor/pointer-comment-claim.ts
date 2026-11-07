import { commentAnchor } from '@kamiazya/whiteboard-canvas-render'
import type { CanvasComment, PinDrop } from '@kamiazya/whiteboard-model'
import { clientPointToRootLocal, type Point, screenToCanvas } from '../../lib/spatial/viewport.js'
import { pickContentAt, pressProbes } from './element-pick.js'
import type { EditorPointerInputs } from './pointer-inputs.js'

/**
 * How far a press on a comment may travel and still be a press: past it, the
 * press is spent as a pin drag (select) or a pan (hand).
 */
export const COMMENT_PRESS_SLOP_PX = 4

type CommentClaimInputs = Pick<
  EditorPointerInputs,
  | 'applyResult'
  | 'canvas'
  | 'capturePointer'
  | 'commentById'
  | 'commentDrag'
  | 'commentPlacementObstacles'
  | 'hitTestComment'
  | 'menuPickInputs'
  | 'openCommentId'
  | 'pressedCommentRef'
  | 'setCommentDrag'
  | 'setContextMenu'
  | 'setOpenCommentId'
  | 'spaceDownRef'
  | 'toggleCommentCard'
  | 'tool'
  | 'viewport'
>

/*
 * A comment's whole part in a pointer gesture: the press it remembers, the
 * pin drag that press can become, the menu over it, and the release that
 * answers it. A comment is CHROME above the document, so every step here
 * runs before the document's own claimants.
 */
/**
 * A press elsewhere on the surface shuts the open card, the way a
 * pointerdown outside a menu shuts the menu. It is the one dismissal a
 * phone has: there is no Escape, and the card covers the bubble whose
 * second press would otherwise toggle it. A press on the open comment's
 * own pin is left to the release, which toggles it shut.
 */
export function dismissCommentCard(c: CommentClaimInputs, point: Point): void {
  if (c.openCommentId !== null && c.hitTestComment(point) !== c.openCommentId) {
    c.setOpenCommentId(null)
  }
}

/**
 * Remembered BEFORE navigation gets the press, because in hand mode
 * navigation takes every plain press as a pan and never hands it back —
 * and a reader panning around a canvas has as much reason to open a
 * conversation as one selecting on it. The release decides: a press that
 * never travelled opens the card under either tool.
 */
export function rememberCommentPress(
  c: CommentClaimInputs,
  e: React.PointerEvent<HTMLDivElement>,
  point: Point,
  screenPoint: Point,
): void {
  const hitCommentId = e.button === 0 ? c.hitTestComment(point) : undefined
  if (hitCommentId === undefined) return
  const comment = c.commentById(hitCommentId)
  if (comment === undefined) return
  c.pressedCommentRef.current = { comment, startScreen: screenPoint, startPoint: point }
}

/**
 * Whether a comment took the press. It never falls through to node or
 * marquee handling, and there is deliberately no double-press-to-edit:
 * a single press opens the card, whose own Edit is the successor, and
 * the second press of a pair would land on that card.
 */
export function commentHoldsPress(c: CommentClaimInputs): boolean {
  return c.pressedCommentRef.current !== null
}

/** A comment under the pointer gets ITS menu, and the selection is left alone. */
export function openCommentMenuAt(
  c: CommentClaimInputs,
  screenPoint: Point,
  point: Point,
): boolean {
  const hitCommentId = c.hitTestComment(point)
  if (hitCommentId === undefined) return false
  c.setContextMenu({
    x: screenPoint.x,
    y: screenPoint.y,
    nodeId: undefined,
    edgeId: undefined,
    commentId: hitCommentId,
    point,
  })
  return true
}

/**
 * A press that travels past the slop is spent as a press. Under the
 * select tool it becomes the pin drag; under the hand tool it was a pan,
 * which navigation is already running. A node or an edge comment drags
 * too: it is carried off its subject and re-anchored wherever it lands
 * (`commitCommentDrag`). The dragged copy is DETACHED and stands where the
 * pin was drawn, so the preview starts under the finger rather than at the
 * fallback point the stored anchor keeps. Decided BEFORE navigation,
 * because a pan's moves never fall through. Capture comes first: it takes
 * the committed copy out of the surface, and a touch pointer's implicit
 * capture sits on that copy.
 */
export function startCommentPinDrag(
  c: CommentClaimInputs,
  e: React.PointerEvent<HTMLDivElement>,
  root: HTMLElement,
  screenPoint: Point,
): boolean {
  const pressed = c.pressedCommentRef.current
  if (
    pressed === null ||
    c.commentDrag !== null ||
    Math.hypot(screenPoint.x - pressed.startScreen.x, screenPoint.y - pressed.startScreen.y) <
      COMMENT_PRESS_SLOP_PX
  ) {
    return false
  }
  // Spent before the tool is consulted, so a hand-tool press that
  // travelled does not come back as a card on release.
  c.pressedCommentRef.current = null
  if (c.tool === 'hand' || c.spaceDownRef.current) return false
  c.capturePointer(root, e.pointerId)
  const drawn = commentAnchor(pressed.comment, c.canvas, edgePathOf(c))
  c.setCommentDrag({
    comment: detachedAt(pressed.comment, drawn),
    startPoint: pressed.startPoint,
    live: screenToCanvas(screenPoint, c.viewport),
    obstacles: c.commentPlacementObstacles(pressed.comment.id),
    dropped: null,
  })
  return true
}

/**
 * A pin in flight follows the pointer until it is dropped. A dropped one
 * still ANSWERS the move — it is the same drag, finished.
 */
export function advanceCommentDrag(c: CommentClaimInputs, screenPoint: Point): boolean {
  const { commentDrag } = c
  if (commentDrag === null) return false
  if (commentDrag.dropped === null) {
    c.setCommentDrag({ ...commentDrag, live: screenToCanvas(screenPoint, c.viewport) })
  }
  return true
}

/**
 * The press, answered at the release — consumed whatever happens next,
 * so it can never open its card two gestures later. In hand mode the
 * press also armed a pan this release is ending, but the pan moved
 * nothing and the comment's answer comes first.
 */
export function releaseCommentPress(c: CommentClaimInputs): boolean {
  const pressed = c.pressedCommentRef.current
  c.pressedCommentRef.current = null
  if (pressed === null || c.commentDrag !== null) return false
  c.toggleCommentCard(pressed.comment.id)
  return true
}

/**
 * The end of a pin drag. A drag that never travelled is a PRESS, which
 * the card toggle owns. The point is ROUNDED because the model requires
 * an integer and a reader silently drops a comment that fails the schema
 * — a fractional anchor from a zoomed viewport would vanish on the next
 * undo, reload or remote import.
 *
 * What the pin lands on is what it is about now: a node, an edge, or the
 * point (model's `movedAnchor`), asked the way a press is — locks aside,
 * since a lock guards a node's content and commenting changes none. The
 * preview parks where the layer will DRAW the pin, which for a node is its
 * corner rather than the drop point, so the committed copy takes over
 * without a step.
 */
export function commitCommentDrag(
  c: CommentClaimInputs,
  e: React.PointerEvent<HTMLDivElement>,
  root: HTMLElement,
): boolean {
  const { commentDrag } = c
  if (commentDrag === null) return false
  if (commentDrag.dropped !== null) return true
  const released = screenToCanvas(clientPointToRootLocal(e, root), c.viewport)
  const dx = released.x - commentDrag.startPoint.x
  const dy = released.y - commentDrag.startPoint.y
  if (dx === 0 && dy === 0) {
    c.setCommentDrag(null)
    c.toggleCommentCard(commentDrag.comment.id)
    return true
  }
  const drop: PinDrop = {
    x: Math.round(commentDrag.comment.x + dx),
    y: Math.round(commentDrag.comment.y + dy),
    ...dropTargetAt(c, released),
  }
  const settled = commentAnchor(
    {
      ...detachedAt(commentDrag.comment, drop),
      ...(drop.nodeId === undefined ? {} : { targetNodeId: drop.nodeId }),
      ...(drop.edgeId === undefined ? {} : { targetEdgeId: drop.edgeId }),
    },
    c.canvas,
    edgePathOf(c),
  )
  c.setCommentDrag({
    ...commentDrag,
    live: {
      x: commentDrag.startPoint.x + (settled.x - commentDrag.comment.x),
      y: commentDrag.startPoint.y + (settled.y - commentDrag.comment.y),
    },
    dropped: settled,
  })
  c.applyResult({
    state: { kind: 'idle' },
    commands: [{ kind: 'move-thread', threadId: commentDrag.comment.id, ...drop } as const],
  })
  return true
}

/**
 * The node or the edge under a dropped pin; ink and empty canvas are neither.
 * A frame's interior answers the frame, as it does for a press, so a pin let
 * go inside a frame is about the frame.
 */
function dropTargetAt(
  c: CommentClaimInputs,
  at: Point,
): { readonly nodeId: string } | { readonly edgeId: string } | Record<never, never> {
  const picked = pickContentAt(pressProbes(c.menuPickInputs), at)
  if (picked?.kind === 'nodes') return { nodeId: picked.id }
  if (picked?.kind === 'edges') return { edgeId: picked.id }
  return {}
}

/** An edge's path as drawn — the same paths a press is hit-tested against, which the layer pins an edge comment on. */
function edgePathOf(c: CommentClaimInputs): (edgeId: string) => readonly Point[] | undefined {
  return (edgeId) => c.menuPickInputs.paths.find((entry) => entry.id === edgeId)?.path
}

/** The comment standing at `at` on its own, naming no node or edge. */
function detachedAt(comment: CanvasComment, at: Point): CanvasComment {
  const { targetNodeId: _node, targetEdgeId: _edge, ...rest } = comment
  return { ...rest, x: at.x, y: at.y }
}

/**
 * A cancelled pin drag writes nothing, and the press that armed it is
 * spent — left set, the next unrelated release would read the stale id
 * and open that comment's card.
 */
export function cancelCommentPress(c: CommentClaimInputs): void {
  c.pressedCommentRef.current = null
  c.setCommentDrag(null)
}
