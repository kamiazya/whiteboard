/**
 * Where a `comment.add` op pins its comment.
 */
import { fail } from './canvas-edit-error.js'
import type { CanvasEditInput } from './canvas-edit-ops.js'
import type { CanvasEditSession } from './canvas-edit-session.js'

type CommentDraft = Extract<CanvasEditInput['ops'][number], { op: 'comment.add' }>['comment']

/**
 * Where a comment's pin sits, refusing a target that is not on the canvas.
 *
 * A target is checked whether or not the caller also gave a point: the point
 * says where the pin sits and the target is what it follows, so a pin on a
 * node that is not there would be written and never move. Refused here rather
 * than kept as a dangling reference, which the model allows only for a subject
 * that LATER goes away.
 */
export function commentAnchor(
  s: CanvasEditSession,
  index: number,
  op: string,
  draft: CommentDraft,
): { x: number; y: number } {
  if (draft.targetNodeId !== undefined && s.nodeAt(draft.targetNodeId) === undefined) {
    fail(index, op, `node "${draft.targetNodeId}" is not on the canvas`)
  }
  if (draft.targetEdgeId !== undefined && s.edgeAt(draft.targetEdgeId) === undefined) {
    fail(index, op, `edge "${draft.targetEdgeId}" is not on the canvas`)
  }
  if (draft.x !== undefined && draft.y !== undefined) return { x: draft.x, y: draft.y }
  const target = draft.targetNodeId === undefined ? undefined : s.nodeAt(draft.targetNodeId)
  // Whole pixels: a node's own coordinates are unrounded numbers, and the
  // comment's anchor is an integer.
  if (target !== undefined) {
    return { x: Math.round(target.x + target.width), y: Math.round(target.y) }
  }
  // An edge is drawn along a route the renderer decides, so the server has no
  // corner of it to anchor at the way it has a node's; the caller says.
  return fail(
    index,
    op,
    draft.targetEdgeId === undefined
      ? 'a comment needs an anchor: give x/y, or a targetNodeId that is on the canvas'
      : 'a comment on an edge needs an anchor: give x/y beside targetEdgeId (only a targetNodeId is anchored for you)',
  )
}
