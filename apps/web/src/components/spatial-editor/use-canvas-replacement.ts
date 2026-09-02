// The controlled-prop-swap policy, extracted from SpatialEditor: when a
// sync-driven parent replaces `canvas` mid-gesture, the reducer is fed a
// `canvas-replaced` event and every piece of state pinned to an id the new
// canvas no longer holds is retired here, in one place. The hook owns the
// previous-value refs the comparison needs and nothing else.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useLayoutEffect, useRef } from 'react'
import { isInFlightGesture } from './drag-preview.js'
import { type GestureState, reduceGesture } from './gestures.js'
import type { SelectionEvent } from './selection.js'

export interface CanvasReplacementInputs {
  canvas: SpatialCanvas
  externalVersion: number | undefined
  gestureState: GestureState
  setGestureState: (state: GestureState) => void
  applySelection: (event: SelectionEvent) => void
  setSelectedEdgeId: (update: (current: string | null) => string | null) => void
  setLivePoint: (point: null) => void
  setSnapGuides: (guides: null) => void
}

export function useCanvasReplacement({
  canvas,
  externalVersion,
  gestureState,
  setGestureState,
  applySelection,
  setSelectedEdgeId,
  setLivePoint,
  setSnapGuides,
}: CanvasReplacementInputs): void {
  const prevCanvasRef = useRef(canvas)
  const prevExternalVersionRef = useRef(externalVersion)

  // Controlled-prop-swap policy: a sync-driven parent can replace `canvas`
  // mid-gesture. Feed the reducer a `canvas-replaced` event so it can abort
  // or continue per gestures.ts's documented contract. `origin` is
  // 'external' only when the caller's `externalVersion` counter itself
  // advanced — that is what tells an undo/redo/remote-import replacement
  // (which must cancel the gesture unconditionally) apart from this
  // component's own controlled re-render after `onChange`.
  // Layout, not passive: this must land before the browser can dispatch the
  // next pointer event, or a pointerup could still be reduced against the
  // gesture the replacement was meant to cancel — committing a delta derived
  // from a canvas that no longer exists. Nothing here reads layout, so the
  // synchronous slot costs nothing and removes the need to reason about when
  // React flushes passive effects relative to input.
  useLayoutEffect(() => {
    const previous = prevCanvasRef.current
    if (previous === canvas) return
    prevCanvasRef.current = canvas
    const isExternal =
      externalVersion !== undefined && externalVersion !== prevExternalVersionRef.current
    prevExternalVersionRef.current = externalVersion
    const result = reduceGesture(gestureState, canvas, {
      type: 'canvas-replaced',
      canvas,
      origin: isExternal ? 'external' : 'local',
    })
    setGestureState(result.state)
    // The gesture is not the only state pinned to a node id: a selection
    // outlives the node it named unless something retires it, and every
    // site that READS the selection filters by laid-out box, so the stale
    // id stays invisible while quietly disabling the verbs. A primary
    // whose node an undo removed leaves `selection` undefined, and the
    // Delete key's own branches are gated on it — two extras keep drawing
    // their outlines while Delete does nothing.
    const held = new Set(canvas.nodes.map((node) => node.id))
    const missingIds = new Set(previous.nodes.map((node) => node.id).filter((id) => !held.has(id)))
    if (missingIds.size > 0) applySelection({ type: 'drop-missing', missingIds })
    // The edge selection is the same story with none of the machinery:
    // no reducer, eighteen hand-maintained writes, and nothing anywhere
    // comparing it against `canvas.edges`. A selected edge that an undo
    // or a peer's delete removed still consumes the Delete key — the
    // edge branch runs first in `handleKeyDown` and returns — so the
    // keypress does nothing at all. Phrased as what VANISHED, like the
    // node half above and for the same reason.
    const heldEdges = new Set(canvas.edges.map((edge) => edge.id))
    const missingEdges = new Set(
      previous.edges.map((edge) => edge.id).filter((id) => !heldEdges.has(id)),
    )
    // Only the SELECTION needs retiring here. The edge label editor
    // resolves its edge in the render and returns null when it is
    // missing, so a second rule for it would be a second mechanism for
    // one invariant — the kind that drifts. The selection has no such
    // gate: every site that reads it filters by what is laid out, which
    // is why a stale id there is invisible rather than inert.
    if (missingEdges.size > 0) {
      setSelectedEdgeId((current) =>
        current !== null && missingEdges.has(current) ? null : current,
      )
    }
    // Mirror gestures.ts's canvas-replaced abort/continue answer into the
    // preview: an abort (result.state no longer in-flight) must retire the
    // preview too, or it would keep drawing a gesture the reducer already
    // cancelled. Uses the SAME predicate applyResult's own clearing check
    // does, so there is exactly one definition of "no longer in flight"
    // rather than two clearing rules that could drift apart.
    if (!isInFlightGesture(result.state)) {
      setLivePoint(null)
      // The guides justify an in-flight snap; outliving the gesture would
      // leave stray lines on the canvas.
      setSnapGuides(null)
    }
    // gestureState intentionally omitted: this effect only reacts to a new
    // canvas identity, not every gestureState transition (that would create
    // an infinite render loop feeding the reducer's own output back in).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, externalVersion])
}
