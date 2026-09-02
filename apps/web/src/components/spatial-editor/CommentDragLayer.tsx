/**
 * The in-flight preview of a comment whose pin is being dragged: the
 * comment's own chrome (leader, pin, bubble) rendered ONCE at the drag's
 * start anchor and translated per frame, the same render-once/transform-
 * per-frame trick the node drag ghost uses (DragPreviewLayer). While it is
 * up, the committed copy of that comment is hidden through its keyed SVG
 * groups (`data-wb-key="<id>/…"`), so the comment is drawn exactly once —
 * a second copy left at the old anchor reads as the drag not working.
 *
 * A side layer rather than a GestureState arm, deliberately: the gesture
 * machine's snapshots, snapping and live-edge routing are all about NODES,
 * and a comment drag needs none of them. ponytail: if a second comment
 * gesture ever needs the machine (multi-select, snapping to nodes), fold
 * this into GestureState and gesture-view's carried set instead.
 */

import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { CanvasComment } from '@kamiazya/whiteboard-model'
import { useMemo } from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { renderCanvasToSvg } from './scene-render.js'
import type { Point } from './viewport.js'

export interface CommentDragLayerProps {
  /** The comment as it was when the drag started (its stored anchor). */
  readonly comment: CanvasComment
  /** Canvas-space delta from the drag's start point to the live pointer. */
  readonly delta: Point
  readonly measure: MeasureText
  readonly theme: ResolvedTheme
}

export function CommentDragLayer({ comment, delta, measure, theme }: CommentDragLayerProps) {
  // Rendered once per drag: `comment` is reference-stable for the gesture
  // (it is the snapshot taken at the press), and the per-frame work is the
  // translate below.
  const fragment = useMemo(
    () =>
      renderCanvasToSvg(
        { nodes: [], edges: [], 'x-whiteboard': { comments: [comment] } },
        { measure, theme },
      ),
    [comment, measure, theme],
  )
  // A CSS string, so quotes and backslashes in an id cannot break out of
  // the attribute selector; `^=` keeps the match to this comment's own
  // `<id>/pin`, `<id>/bubble`, `<id>/leader` and bubble-content groups.
  const hideCommitted = `[data-testid="canvas-content"] [data-wb-key^=${JSON.stringify(`${comment.id}/`)}]{visibility:hidden}`
  return (
    <>
      <style>{hideCommitted}</style>
      <div
        data-testid="comment-drag-preview"
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: fragment.bounds.x + delta.x,
          top: fragment.bounds.y + delta.y,
          pointerEvents: 'none',
          opacity: 0.85,
        }}
        // Same trusted producer as the committed scene: canvas-render's
        // escaping serializer is the sole source of this string.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: same trusted producer as the committed scene — canvas-render's escaping serializer
        dangerouslySetInnerHTML={{ __html: fragment.svg }}
      />
    </>
  )
}
