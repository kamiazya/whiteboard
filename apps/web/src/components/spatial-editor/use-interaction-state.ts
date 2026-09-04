// The gesture/selection interaction state, extracted from SpatialEditor:
// the multi-selection, the gesture machine, the per-frame preview values
// (livePoint, snapGuides, marquee), the mutable canvas mirror every
// callback-that-outlives-its-render reads instead of a stale closure, and
// the gesture-arming refs (double-press, last-press, space-down,
// active-pointer, navigation, long-press). Called first, ahead of every
// other cluster: `selectionState` is this component's earliest declaration.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useRef, useState } from 'react'
import { createIdleState, type GestureState } from './gestures.js'
import { createIdleNavigation, type NavigationState } from './navigation.js'
import {
  EMPTY_SELECTION,
  reduceSelection,
  type SelectionEvent,
  type SelectionState,
} from './selection.js'
import type { Point } from './viewport.js'

export interface InteractionStateInputs {
  readonly canvas: SpatialCanvas
}

export function useInteractionState({ canvas }: InteractionStateInputs) {
  /**
   * The multi-selection lives in ONE state object and every transition
   * routes through the pure `reduceSelection` (selection.ts), so its
   * invariants (primary never inside extras; extras only with a primary)
   * hold by construction — never hand-write a primary/extras update pair.
   * Functional updates make sequential events inside one handler compose
   * instead of clobbering each other through stale closures.
   */
  const [selectionState, setSelectionState] = useState<SelectionState>(EMPTY_SELECTION)
  const applySelection = (event: SelectionEvent) =>
    setSelectionState((prev) => reduceSelection(prev, event))
  const [gestureState, setGestureState] = useState<GestureState>(createIdleState())
  /**
   * Live pointer position during an in-flight move/resize/connect, in canvas
   * space. Component-local on purpose: the reducer still recomputes the real
   * commit from startPoint at pointerup, so this drives ONLY the preview
   * overlay below and never becomes a source of truth. Keeping it out of
   * `canvas` is what stops a per-frame `renderCanvasToSvg` (measured at
   * ~30ms on an 80-node canvas — far past a frame budget).
   */
  const [livePoint, setLivePoint] = useState<Point | null>(null)
  /**
   * Canvas-space lines justifying the current snap, cleared with the
   * gesture. Same rationale as `livePoint`: a per-frame value that drives
   * only an overlay, never the document.
   */
  const [snapGuides, setSnapGuides] = useState<{
    readonly x: readonly number[]
    readonly y: readonly number[]
  } | null>(null)
  /**
   * Armed by a second same-target press inside the double-press window;
   * RESOLVED at pointerup: zero movement opens the editor (node) or
   * creates (empty), any movement means it was a drag all along. Firing
   * at the release also sidesteps mousedown's default focus action, which
   * used to blur the just-mounted textarea when we opened at the press.
   */
  const doublePressRef = useRef<{ key: string; point: Point } | null>(null)
  /** In-flight marquee selection rect, in canvas space (Excalidraw
   * semantics: plain drag on empty space selects; pan is Space+drag,
   * middle-button drag, or wheel). */
  const [marquee, setMarquee] = useState<{ start: Point; current: Point } | null>(null)
  const spaceDownRef = useRef(false)
  /**
   * Last press for the SELECT tool's double press, keyed by what was under
   * it — a node id, an edge id, or `'empty'`. Hand mode's own double press
   * is not here: it has no target to key on, so the navigation machine
   * holds it with the distance bound that keying cannot supply.
   */
  const lastPressRef = useRef<{ key: string; at: number; point: Point } | null>(null)
  /**
   * The pointerId this component currently holds capture for, or `null`.
   * Tracked so unmount can best-effort release capture (see the teardown
   * effect below) even though no window-level fallback listener exists to
   * do it otherwise — mirrors `trySetPointerCapture`'s own
   * best-effort/never-throw reasoning.
   */
  const activePointerIdRef = useRef<number | null>(null)
  /**
   * Everything navigation owns, as one value: which fingers are down, what
   * is driving the viewport, what the last hand press was. See
   * `navigation.ts` — the refs this replaced could not say when a gesture
   * was over, and twice shipped a field that outlived one.
   */
  const navigationRef = useRef<NavigationState>(createIdleNavigation())

  const canvasRef = useRef(canvas)
  canvasRef.current = canvas

  // Mirror for callbacks that outlive their render — the long-press timer
  // fires ~500ms after the closure that armed it, by which time the press
  // itself has usually advanced the gesture ('pressing'/'moving'); reducing
  // a cancel against the ARM-time state would mis-apply it.
  const gestureStateRef = useRef(gestureState)
  gestureStateRef.current = gestureState

  /**
   * Touch long-press -> context menu. iOS Safari never synthesises a
   * `contextmenu` event from a touch long-press (Android Chrome does), so
   * without this the app's object menu is simply unreachable on an iPhone
   * — the press reads as a drag start and the menu never opens. Armed on
   * a single stationary touch, cancelled by movement past the slop, a
   * second finger, or lift.
   */
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout>
    pointerId: number
    screen: Point
  } | null>(null)
  const clearLongPress = () => {
    if (longPressRef.current !== null) {
      clearTimeout(longPressRef.current.timer)
      longPressRef.current = null
    }
  }

  return {
    selectionState,
    setSelectionState,
    applySelection,
    gestureState,
    setGestureState,
    gestureStateRef,
    livePoint,
    setLivePoint,
    snapGuides,
    setSnapGuides,
    doublePressRef,
    marquee,
    setMarquee,
    spaceDownRef,
    lastPressRef,
    activePointerIdRef,
    navigationRef,
    canvasRef,
    longPressRef,
    clearLongPress,
  }
}
