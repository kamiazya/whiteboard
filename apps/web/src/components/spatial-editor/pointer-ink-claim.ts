import { defaultCreateId } from '../../lib/spatial/element-id.js'
import { continuesStroke } from '../../lib/spatial/stroke-group.js'
import { clientPointToRootLocal, type Point, screenToCanvas } from '../../lib/spatial/viewport.js'
import { reduceGesture } from './gestures.js'
import { withGroupMates } from './ink-hit.js'
import type { EditorPointerInputs } from './use-editor-pointer.js'

type InkClaimInputs = Pick<
  EditorPointerInputs,
  | 'applyResult'
  | 'canvas'
  | 'canvasRef'
  | 'capturePointer'
  | 'createId'
  | 'gestureState'
  | 'gestureStateRef'
  | 'lastStrokeRef'
  | 'selectedInkIds'
  | 'setEdgeLabelEditId'
  | 'setSelectedInkIds'
  | 'tool'
  | 'viewport'
>

/*
 * Ink's part in a pointer gesture: the stroke the draw tool lays down, and
 * the drag that carries strokes already on the board. Both are unsnapped —
 * snapping lines an object up with its neighbours, and a hand-drawn stroke
 * has no such intent — and the stroke's own release is `pointer-release.ts`'s.
 */

/**
 * The draw tool makes the board a sheet of paper: a press starts a stroke,
 * with no hit-test at all. It sits after the annotation layer's own chrome,
 * which keeps its press. Capture is taken HERE rather than on the first move,
 * or a stroke that leaves the root stops at its edge and the release is
 * never seen.
 */
export function beginDrawStroke(
  c: InkClaimInputs,
  e: React.PointerEvent<HTMLDivElement>,
  root: HTMLElement,
  point: Point,
): boolean {
  if (c.tool !== 'draw') return false
  c.capturePointer(root, e.pointerId)
  // Which MARK this stroke belongs to, decided here because this is where
  // the clock is: a stroke that goes down soon after the last one came up,
  // near where it was drawn, is the next stroke of the same character rather
  // than a new one (`stroke-group.ts`). The reducer's own default mints the
  // id, so a test injecting `createId` gets deterministic groups.
  const previous = c.lastStrokeRef.current ?? undefined
  const group = continuesStroke(previous, e.timeStamp, point, c.viewport.zoom)
    ? previous?.group
    : (c.createId ?? defaultCreateId)()
  c.applyResult(
    reduceGesture(c.gestureState, c.canvas, {
      type: 'pointerdown-draw',
      point,
      zoom: c.viewport.zoom,
      ...(group === undefined ? {} : { group }),
    }),
  )
  return true
}

/**
 * A press on a stroke over empty board arms it to travel, answering whether
 * it did. A press on a MEMBER keeps the whole set; anything else replaces it
 * with the pressed stroke's MARK — a handwritten character is several
 * strokes and a person pressing one means it. `pointerdown-ink` drops every
 * id that is not a stroke, so a press on a RELATION arms nothing: an edge's
 * path is routed from the boxes it joins and has no geometry of its own.
 */
export function armInkDrag(c: InkClaimInputs, point: Point, hitPathId: string): boolean {
  const travelling = c.selectedInkIds.includes(hitPathId)
    ? c.selectedInkIds
    : withGroupMates([hitPathId], c.canvas.lines)
  c.setSelectedInkIds(travelling)
  const armed = reduceGesture(c.gestureState, c.canvas, {
    type: 'pointerdown-ink',
    ids: travelling,
    point,
  })
  if (armed.state.kind !== 'moving-ink') return false
  c.applyResult(armed)
  return true
}

/**
 * A stroke in progress takes each move. Reduced from the PREVIOUS state
 * through the refs rather than this render's `gestureState`: `pointermove`
 * is continuous, so several arrive before React re-renders, and reducing
 * from the render's state has each move overwrite the last. Measured on a
 * 61-sample wave drawn in one turn: ONE bend survived. No other gesture
 * needs this — they recompute from their start snapshot and accumulate
 * nothing.
 */
export function advanceDrawing(c: InkClaimInputs, screenPoint: Point): boolean {
  if (c.gestureStateRef.current.kind !== 'drawing') return false
  c.applyResult(
    reduceGesture(c.gestureStateRef.current, c.canvasRef.current, {
      type: 'pointermove',
      point: screenToCanvas(screenPoint, c.viewport),
    }),
  )
  return true
}

/**
 * The end of an ink drag. It replaced the marquee a press on ink used to
 * start, and two things that branch did for such a press came with it. Focus
 * is taken at the RELEASE because ink has no focusable element of its own,
 * so without it Delete and Escape land on `<body>` — and the browser's own
 * mousedown focus handling would undo one taken at the press. A double press
 * on a stroke edits its label, exactly as on a relation: the press key is
 * `edge:<id>` for both.
 */
export function releaseInkDrag(
  c: InkClaimInputs,
  e: React.PointerEvent<HTMLDivElement>,
  root: HTMLElement,
  armed: { key: string; point: Point } | null,
): boolean {
  if (c.gestureState.kind !== 'moving-ink') return false
  const released = screenToCanvas(clientPointToRootLocal(e, root), c.viewport)
  c.applyResult(reduceGesture(c.gestureState, c.canvas, { type: 'pointerup', point: released }))
  if (armed?.key.startsWith('edge:')) {
    c.setEdgeLabelEditId(armed.key.slice('edge:'.length))
  }
  root.focus()
  return true
}
