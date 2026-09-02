/**
 * The in-flight preview of a comment whose pin is being dragged: the
 * comment's own chrome (leader, pin, bubble) rendered ONCE at the drag's
 * start anchor and translated per frame, the same render-once/transform-
 * per-frame trick the node drag ghost uses (DragPreviewLayer). While it is
 * up, the committed copy of that comment is LEFT OUT of the keyed surface
 * (see `keyedWithoutPrefix`), so the comment is drawn exactly once — a
 * second copy left at the old anchor reads as the drag not working, and a
 * hidden one comes back animated on the drop.
 *
 * `obstacles` are what the committed scene placed this comment's bubble
 * against — the canvas's nodes and the bubbles before it — so the preview
 * at delta zero coincides with the drawn chrome instead of re-placing the
 * bubble in the empty canvas it is rendered in.
 *
 * A side layer rather than a GestureState arm, deliberately: the gesture
 * machine's snapshots, snapping and live-edge routing are all about NODES,
 * and a comment drag needs none of them. ponytail: if a second comment
 * gesture ever needs the machine (multi-select, snapping to nodes), fold
 * this into GestureState and gesture-view's carried set instead.
 */

import type { BoundingBox, MeasureText } from '@kamiazya/whiteboard-canvas-render'
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
  /** Boxes the bubble is placed around; reference-stable for the gesture. */
  readonly obstacles: readonly BoundingBox[]
}

export function CommentDragLayer({
  comment,
  delta,
  measure,
  theme,
  obstacles,
}: CommentDragLayerProps) {
  // Rendered once per drag: `comment` is reference-stable for the gesture
  // (it is the snapshot taken at the press), and the per-frame work is the
  // translate below.
  const fragment = useMemo(
    () =>
      renderCanvasToSvg(
        { nodes: [], edges: [], 'x-whiteboard': { comments: [comment] } },
        // The dragged comment was hit-tested on the drawn scene, so it is
        // visible whatever its resolved state: draw it unconditionally.
        { measure, theme, commentObstacles: obstacles, showResolved: true },
      ),
    [comment, measure, theme, obstacles],
  )
  return (
    <>
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
