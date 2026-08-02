/**
 * Pure derivation of the in-flight gesture preview from the gesture's own
 * start snapshot plus the live pointer position — never from `canvas`, so it
 * costs a few arithmetic ops per pointermove regardless of canvas size. This
 * is what makes the overlay approach viable: `renderCanvasToSvg` measures at
 * ~0.37ms/node (linear), crossing a 16.7ms frame budget around 30-40 nodes,
 * so a per-frame full render was never on the table (see SpatialEditor.tsx's
 * `svg`/`bounds` memo for the actual render path this keeps off the hot
 * loop).
 *
 * `DragPreview` is component-internal view state: it never reaches
 * `onChange`, an `EditorCommand`, persisted JSON, or the wire — the same
 * reasoning canvas-render's scene graph uses for staying plain TS (see
 * package-canvas-render.md's "scene graph stays plain TS" decision) — so per
 * YAGNI + zod-schema-discipline this type deliberately carries no Zod schema.
 */
import type { Box, NodeBox } from './geometry.js'
import { resizeBoxByDelta } from './geometry.js'
import type { GestureState } from './gestures.js'
import type { Point } from './viewport.js'

export type DragPreview =
  | { readonly kind: 'box'; readonly box: Box }
  | { readonly kind: 'line'; readonly from: Point; readonly to: Point }

/**
 * Returns the preview geometry for the gesture currently in flight, or
 * `undefined` when there is nothing to preview (idle/editing-text state, no
 * live pointer yet, or the gesture's target node has since disappeared from
 * `boxes` — e.g. deleted mid-drag by a canvas-replaced event). Total: never
 * throws, never returns non-finite geometry for finite inputs.
 *
 * The resize branch calls `resizeBoxByDelta` — the SAME function
 * `reducePointerUpResizing` (gestures.ts) commits with at pointerup — so the
 * preview and the eventual commit cannot drift apart. If this function is
 * ever restructured, keep calling that shared helper rather than
 * reimplementing the resize arithmetic inline: a parallel implementation is
 * exactly the class of bug this comment exists to prevent.
 */
export function computeDragPreview(
  gestureState: GestureState,
  boxes: readonly NodeBox[],
  livePoint: Point | null,
): DragPreview | undefined {
  if (livePoint === null) return undefined
  if (gestureState.kind === 'moving') {
    const box = boxes.find((b) => b.id === gestureState.nodeId)?.box
    if (box === undefined) return undefined
    return {
      kind: 'box',
      box: {
        ...box,
        x: gestureState.startX + (livePoint.x - gestureState.startPoint.x),
        y: gestureState.startY + (livePoint.y - gestureState.startPoint.y),
      },
    }
  }
  if (gestureState.kind === 'resizing') {
    return {
      kind: 'box',
      box: resizeBoxByDelta(
        gestureState.startBox,
        gestureState.handle,
        livePoint.x - gestureState.startPoint.x,
        livePoint.y - gestureState.startPoint.y,
      ),
    }
  }
  if (gestureState.kind === 'connecting') {
    const box = boxes.find((b) => b.id === gestureState.fromNodeId)?.box
    if (box === undefined) return undefined
    return {
      kind: 'line',
      from: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      to: livePoint,
    }
  }
  return undefined
}

/**
 * Whether `state` describes a gesture with an active preview (move, resize,
 * connect). Shared by SpatialEditor.tsx's two preview-clearing call sites
 * (the normal `applyResult` path and the `canvas-replaced` abort path) so
 * both agree on exactly one definition of "no longer in flight" rather than
 * risking two clearing rules drifting apart.
 */
export function isInFlightGesture(state: GestureState): boolean {
  return state.kind === 'moving' || state.kind === 'resizing' || state.kind === 'connecting'
}
