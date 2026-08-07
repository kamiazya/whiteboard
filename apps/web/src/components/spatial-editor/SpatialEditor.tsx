/**
 * A read-write editor for a `SpatialCanvas`, built on canvas-render's
 * `layoutSpatialCanvas` + `renderSceneToSvg` (the same scene builder
 * canvas-viewer's read-only `CanvasViewer` uses — this is NOT a fourth
 * scene builder).
 *
 * Supported: display, pan, zoom, select (click / click-empty-to-clear),
 * move (drag a selected node), resize (drag a corner/edge handle,
 * anchor-preserving, OR arrow-key nudge a focused resize handle), edit
 * text (double-click a text node; commits on blur/Cmd+Enter, Escape
 * cancels), connect an edge (drag from a selected node's connect handle
 * onto another node, OR Enter/Space the connect handle then Tab to a
 * target node's connect-target control and Enter/Space it; Escape cancels
 * an in-flight gesture from the keyboard too), create a node (double-click
 * empty canvas space, or the keyboard-reachable "Add note" button — both
 * open the new node for typing immediately), and delete the current
 * selection (Delete/Backspace, disabled while its text editor is open so
 * Backspace-while-typing edits text instead of deleting the node).
 *
 * The component is CONTROLLED and owns no persistence: every mutating
 * gesture calls `onChange(next, command)` with a brand-new `SpatialCanvas`
 * value (see `commands.ts`) — it never mutates the `canvas` prop.
 *
 * NOT yet supported (see `SPATIAL_EDITOR_UNSUPPORTED`): freehand drawing
 * and shape tools (`x-whiteboard` extension authoring — its own slice),
 * grouping, undo/redo, arrow-side pinning, snapping,
 * persistence, and sync. Those are later phases.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { ContextMenu } from './ContextMenu.js'
import type { EditorCommand } from './commands.js'
import { applyCommand } from './commands.js'
import { DragPreviewLayer } from './DragPreviewLayer.js'
import { computeDragPreview, isInFlightGesture } from './drag-preview.js'
import { editorTextFill } from './editor-appearance.js'
import type { Box, ResizeHandleKind } from './geometry.js'
import { findFreeSpot, hitTest, indexNodeBoxes, resizeBoxByDelta } from './geometry.js'
import type { GestureState } from './gestures.js'
import { createIdleState, NEW_NODE_HEIGHT, NEW_NODE_WIDTH, reduceGesture } from './gestures.js'
import { SelectionOverlay } from './SelectionOverlay.js'
import { renderCanvasToSvg, requiredTextNodeHeight } from './scene-render.js'
import { TextNodeEditor } from './TextNodeEditor.js'
import { type EditorTool, ToolPalette } from './ToolPalette.js'
import {
  fitViewportToBoxes,
  IDENTITY_VIEWPORT,
  type Point,
  panBy,
  screenToCanvas,
  type Viewport,
  viewportTransformCss,
  zoomAt,
} from './viewport.js'

/**
 * Machine-checkable out-of-scope list this slice deliberately does not
 * implement — referenced above and asserted by `doc-contract.test.ts`.
 */
export const SPATIAL_EDITOR_UNSUPPORTED = [
  'freehand-drawing',
  'shape-tools',
  'grouping',
  'undo-redo',
  'arrow-side-pinning',
  'snapping',
  'persistence',
  'sync',
] as const

export interface SpatialEditorProps {
  readonly canvas: SpatialCanvas
  readonly onChange: (next: SpatialCanvas, command: EditorCommand) => void
  /**
   * Bumps only on an externally-originated canvas replacement (undo, redo,
   * remote import, hydrate) — never on this component's own `onChange`.
   * Omitted (the default) means every `canvas` prop change is treated as
   * local, matching this component's pre-existing continue-if-valid
   * behavior. A controlling hook that distinguishes origins (see
   * `useCanvasSync`'s `externalVersion`) should always pass it, since an
   * external replacement must cancel an in-flight gesture unconditionally —
   * see gestures.ts's `canvas-replaced` origin contract.
   */
  readonly externalVersion?: number
  /** Injection seam for tests; defaults to the real Canvas 2D measurer. */
  readonly measure?: MeasureText
  /** Injection seam for deterministic node/edge-id tests; defaults to crypto.randomUUID. */
  readonly createId?: () => string
  readonly className?: string
  readonly testId?: string
  /**
   * The app's resolved UI theme, threaded straight from `useThemeMode` by
   * the caller. Defaults to `'light'` so existing mounts render the
   * pre-existing chrome unchanged; every real page mount must pass its own
   * `resolvedTheme` or its nodes/edges go invisible in dark mode.
   */
  readonly theme?: ResolvedTheme
}

/** Imperative surface for a page that needs to drive the viewport from
 * outside (e.g. a daemon's `viewport_request`) without owning viewport as
 * its own state. */
export interface SpatialEditorHandle {
  setViewport(viewport: Viewport): void
  /** Fits the viewport to the given node ids, or to every node when omitted. */
  fitToContent(nodeIds?: readonly string[]): void
}

const DEFAULT_TEST_ID = 'spatial-editor'
/**
 * Window for OUR double-press detection (see handlePointerDown). Matches the
 * common OS double-click interval; not user-configurable today.
 */
const DOUBLE_PRESS_WINDOW_MS = 400
const ZOOM_WHEEL_FACTOR = 1.1
/** Canvas-space px per arrow-key nudge on a focused resize handle; Shift multiplies by 4. */
const RESIZE_KEYBOARD_STEP = 8
const RESIZE_KEYBOARD_STEP_LARGE = 32
const ARROW_KEY_DELTA: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
}

function clientPointToRootLocal(e: { clientX: number; clientY: number }, root: HTMLElement) {
  const rect = root.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

/**
 * Pointer capture is best-effort chrome, not a correctness requirement: a
 * browser can reject it (e.g. `NotFoundError` for a pointerId the platform
 * has no active record of, which synthetic/programmatic pointer dispatch
 * can trigger). This component registers no window-level fallback
 * listeners, so a rejected/lost capture is instead recovered via
 * `onLostPointerCapture`, which cancels whatever gesture is in flight —
 * see its handler below.
 */
function trySetPointerCapture(root: HTMLElement, pointerId: number): void {
  try {
    root.setPointerCapture(pointerId)
  } catch {
    // best-effort — see doc comment above
  }
}

export const SpatialEditor = forwardRef<SpatialEditorHandle, SpatialEditorProps>(
  function SpatialEditor(
    {
      canvas,
      onChange,
      externalVersion,
      measure,
      createId,
      className,
      testId = DEFAULT_TEST_ID,
      theme = 'light',
    },
    forwardedRef,
  ) {
    const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])
    const rootRef = useRef<HTMLDivElement | null>(null)

    const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT)
    const [selectedId, setSelectedId] = useState<string | null>(null)
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
    // OOUI interaction mode (S6/S7): Select is the default and matches the
    // pre-tool behavior byte-for-byte; Connect arms object-first click-A,
    // click-B edge creation. Creation is deliberately NOT a mode — the
    // palette's Add note and double-click-anywhere both work in every mode.
    const [tool, setTool] = useState<EditorTool>('select')
    /** Open right-click menu: screen position (root-relative) + hit target. */
    const [contextMenu, setContextMenu] = useState<{
      x: number
      y: number
      nodeId: string | undefined
      point: Point
    } | null>(null)
    /**
     * Additional selected node ids beyond the reducer's single primary
     * selection. Multi-select lives at the component layer on purpose: the
     * gesture reducer keeps its single-node contract, and group operations
     * expand into per-member commands at commit time (see the pointerup and
     * delete paths). Cleared whenever the primary selection clears.
     */
    const [extraIds, setExtraIds] = useState<ReadonlySet<string>>(new Set())
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
    const isPanningRef = useRef(false)
    /** Last primary press for double-press detection: logical target + time. */
    const lastPressRef = useRef<{ key: string; at: number } | null>(null)
    const lastPanPointRef = useRef({ x: 0, y: 0 })
    /**
     * The pointerId this component currently holds capture for, or `null`.
     * Tracked so unmount can best-effort release capture (see the teardown
     * effect below) even though no window-level fallback listener exists to
     * do it otherwise — mirrors `trySetPointerCapture`'s own
     * best-effort/never-throw reasoning.
     */
    const activePointerIdRef = useRef<number | null>(null)

    const canvasRef = useRef(canvas)
    const prevCanvasRef = useRef(canvas)
    const prevExternalVersionRef = useRef(externalVersion)
    canvasRef.current = canvas

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
      if (prevCanvasRef.current === canvas) return
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
      // Mirror gestures.ts's canvas-replaced abort/continue answer into the
      // preview: an abort (result.state no longer in-flight) must retire the
      // preview too, or it would keep drawing a gesture the reducer already
      // cancelled. Uses the SAME predicate applyResult's own clearing check
      // below does, so there is exactly one definition of "no longer in
      // flight" rather than two clearing rules that could drift apart.
      if (!isInFlightGesture(result.state)) setLivePoint(null)
      // gestureState intentionally omitted: this effect only reacts to a new
      // canvas identity, not every gestureState transition (that would create
      // an infinite render loop feeding the reducer's own output back in).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvas, externalVersion])

    const { svg, bounds } = useMemo(
      () => renderCanvasToSvg(canvas, { measure: resolvedMeasure, theme }),
      [canvas, resolvedMeasure, theme],
    )
    const boxes = useMemo(() => indexNodeBoxes(canvas), [canvas])

    /**
     * The dragged node's own content, rendered ONCE per drag (the reducer's
     * pointermove passthrough returns the same state reference, so this memo
     * holds for the whole gesture; a single-node render costs ~0.4ms).
     * Per-frame motion is then a pure CSS transform in DragPreviewLayer —
     * the full-canvas render stays untouched during the drag.
     */
    const dragContentSvg = useMemo(() => {
      if (gestureState.kind !== 'moving') return undefined
      const node = canvas.nodes.find((n) => n.id === gestureState.nodeId)
      if (node === undefined) return undefined
      const rendered = renderCanvasToSvg(
        { nodes: [node], edges: [] },
        { measure: resolvedMeasure, theme },
      )
      return {
        svg: rendered.svg,
        originX: gestureState.startX - rendered.bounds.x,
        originY: gestureState.startY - rendered.bounds.y,
      }
    }, [gestureState, canvas, resolvedMeasure, theme])

    useImperativeHandle(
      forwardedRef,
      () => ({
        setViewport,
        fitToContent(nodeIds) {
          const scoped = nodeIds === undefined ? boxes : boxes.filter((b) => nodeIds.includes(b.id))
          setViewport(fitViewportToBoxes(scoped.map((b) => b.box)))
        },
      }),
      [boxes],
    )

    const selectedBox = useMemo(
      () => (selectedId === null ? undefined : boxes.find((b) => b.id === selectedId)?.box),
      [boxes, selectedId],
    )
    const selectedNode = useMemo(
      () => (selectedId === null ? undefined : canvas.nodes.find((n) => n.id === selectedId)),
      [canvas, selectedId],
    )
    /** Narrowed pair so the overlay never has to assert a non-null `selectedId`. */
    const selection =
      selectedId !== null && selectedBox !== undefined
        ? { id: selectedId, box: selectedBox }
        : undefined

    /**
     * The in-flight preview geometry, derived per frame from the gesture's own
     * start snapshot plus the live pointer — never from `canvas`. See
     * drag-preview.ts for why that matters and for the single-source
     * `resizeBoxByDelta` guarantee it documents.
     */
    const dragPreview = useMemo(
      () => computeDragPreview(gestureState, boxes, livePoint),
      [gestureState, livePoint, boxes],
    )

    /**
     * Folds `result.commands` in order over a LOCAL running canvas (seeded
     * from `canvasRef.current`, never re-read from the ref between steps) so
     * a multi-command result — e.g. a pending-text commit ordered ahead of a
     * create-node — can never lose its first command to a stale read. Each
     * command still gets its own `onChange` call, one canvas/command pair
     * per mutation, matching this component's pre-existing one-call-per-
     * command contract for the (still common) single-command case.
     */
    const applyResult = (result: ReturnType<typeof reduceGesture>) => {
      // Any gesture that leaves an in-flight state retires the preview: the
      // committed canvas is about to draw the real thing. Same predicate the
      // canvas-replaced effect above uses, so both agree on one definition.
      if (!isInFlightGesture(result.state)) setLivePoint(null)
      setGestureState(result.state)
      if (result.selectedId !== undefined) setSelectedId(result.selectedId)
      let running = canvasRef.current
      for (const command of result.commands) {
        running = applyCommand(running, command)
        onChange(running, command)
        // Grow-only auto-fit: a committed body that lays out taller than the
        // stored box gets a follow-up resize so content never overflows the
        // border. Never shrinks — an authored roomy box (or manual enlarge)
        // is respected. Stored geometry stays truthful, so export (the same
        // layout over the same canvas) renders exactly what the editor shows.
        if (command.kind === 'set-text') {
          const node = running.nodes.find((n) => n.id === command.id)
          if (node !== undefined && node.type === 'text') {
            const required = Math.ceil(
              requiredTextNodeHeight(node, { measure: resolvedMeasure, theme }),
            )
            if (required > node.height) {
              const grow = {
                kind: 'resize-node',
                id: node.id,
                x: node.x,
                y: node.y,
                width: node.width,
                height: required,
              } as const
              running = applyCommand(running, grow)
              onChange(running, grow)
            }
          }
        }
      }
      // Written back HERE, not only from the canvas prop at re-render: two
      // commits landing in one tick (key auto-repeat, batched events) would
      // otherwise both compute from the pre-commit ref and the second would
      // clobber the first.
      canvasRef.current = running
    }

    /**
     * Takes pointer capture and records which pointer we hold it for, as one
     * step: the ref is what the unmount teardown effect releases from, so it
     * must never be updated independently of the capture itself.
     */
    const capturePointer = (root: HTMLElement, pointerId: number): void => {
      trySetPointerCapture(root, pointerId)
      activePointerIdRef.current = pointerId
    }

    /**
     * Shared prologue for the overlay's pointer handlers: take pointer capture
     * on the root and hand it back, or `null` when the root is not mounted.
     * (The overlay itself already stops propagation to the root's hit-test.)
     */
    const beginOverlayGesture = (e: React.PointerEvent): HTMLDivElement | null => {
      const root = rootRef.current
      if (root !== null) capturePointer(root, e.pointerId)
      return root
    }

    /**
     * True when the event originated inside an overlay control (the Add
     * note button, the text editor, a future tool palette) rather than the
     * canvas surface. The root's gesture handlers must ignore those:
     * capturing the pointer on such a press retargets the subsequent
     * `click` to the capturing root, so the control's own onClick never
     * fires — a press on "Add note" silently did nothing. Overlay controls
     * opt in via `data-editor-overlay`; a per-control stopPropagation is
     * exactly the thing someone forgets (this bug), so the guard lives here
     * where forgetting is impossible.
     */
    const isOverlayEvent = (e: React.SyntheticEvent) =>
      e.target instanceof Element && e.target.closest('[data-editor-overlay]') !== null

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (isOverlayEvent(e)) return
      const root = rootRef.current
      if (root === null) return
      const screenPointForPan = clientPointToRootLocal(e, root)
      // Middle-button (or Space-held) drag pans from ANYWHERE — Excalidraw
      // semantics; a plain left drag on empty space marquee-selects instead.
      if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
        e.preventDefault()
        isPanningRef.current = true
        lastPanPointRef.current = screenPointForPan
        return
      }
      if (e.button !== 0) return
      // Deliberately NO pointer capture here. Capturing on the press
      // retargets the subsequent clicks to the capturing root, so a control
      // the press bubbled from never receives its click. Capture is taken
      // on the first real pointermove instead (see handlePointerMove): a
      // press that turns into a drag still gets capture before it can
      // escape the element. Overlay handle/connect gestures are the
      // exception (beginOverlayGesture) — they want capture immediately.
      const screenPoint = clientPointToRootLocal(e, root)
      const point = screenToCanvas(screenPoint, viewport)
      const hitId = hitTest(boxes, point)

      // Double-press detection is OURS, not the browser's `dblclick`: the
      // first press selects the node, which re-renders the DOM under the
      // pointer (selection overlay, gesture state), so the second click can
      // land on a different element instance and Chromium then never
      // synthesises a dblclick at all. Detecting two presses on the same
      // logical target within the OS-conventional window is stable against
      // re-renders because it compares node ids, not DOM identity.
      // Shift-click builds a multi-selection instead of starting a gesture.
      if (e.shiftKey && hitId !== undefined) {
        if (selectedId === null) {
          setSelectedId(hitId)
        } else if (hitId === selectedId) {
          // Deselecting the primary promotes an extra, if any.
          const [next, ...rest] = [...extraIds]
          setSelectedId(next ?? null)
          setExtraIds(new Set(rest))
        } else {
          const next = new Set(extraIds)
          if (next.has(hitId)) next.delete(hitId)
          else next.add(hitId)
          setExtraIds(next)
        }
        return
      }
      const pressKey = hitId ?? 'empty'
      const now = e.timeStamp
      const isDoublePress =
        lastPressRef.current !== null &&
        lastPressRef.current.key === pressKey &&
        now - lastPressRef.current.at <= DOUBLE_PRESS_WINDOW_MS
      lastPressRef.current = isDoublePress ? null : { key: pressKey, at: now }
      doublePressRef.current = isDoublePress ? { key: pressKey, point } : null

      if (hitId === undefined) {
        setMarquee({ start: point, current: point })
        setExtraIds(new Set())
        applyResult(reduceGesture(gestureState, canvas, { type: 'pointerdown-empty' }))
        return
      }
      // A plain press on a NON-member collapses the multi-selection; a press
      // on a member keeps it (that press starts a group move).
      if (hitId !== undefined && hitId !== selectedId && !extraIds.has(hitId)) {
        setExtraIds(new Set())
      }
      // Connect tool: the FIRST node press arms the connect (the same
      // reducer arm the keyboard/handle flows use). While 'connecting', a
      // node press is swallowed — the connect completes on the POINTERUP
      // over the target (the reducer's completion arm), so dispatching a
      // plain pointerdown here would tear the in-flight connect down first.
      if (tool === 'connect' && hitId !== undefined) {
        if (gestureState.kind !== 'connecting') {
          applyResult(
            reduceGesture(gestureState, canvas, { type: 'pointerdown-connect', nodeId: hitId }),
          )
        }
        return
      }
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'pointerdown', nodeId: hitId, point }),
      )
    }

    const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
      if (isOverlayEvent(e)) return
      // Replace the browser menu with the object's own action menu.
      e.preventDefault()
      const root = rootRef.current
      if (root === null) return
      const screenPoint = clientPointToRootLocal(e, root)
      const point = screenToCanvas(screenPoint, viewport)
      const hitId = hitTest(boxes, point)
      if (hitId !== undefined) setSelectedId(hitId)
      setContextMenu({ x: screenPoint.x, y: screenPoint.y, nodeId: hitId, point })
    }

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const root = rootRef.current
      if (root === null) return
      // First movement of an in-flight gesture: take capture now (see the
      // handlePointerDown comment for why not at the press). Idempotent —
      // re-capturing the same pointer is a no-op.
      if (
        activePointerIdRef.current === null &&
        (isPanningRef.current || gestureState.kind !== 'idle')
      ) {
        capturePointer(root, e.pointerId)
      }
      const screenPoint = clientPointToRootLocal(e, root)
      if (marquee !== null) {
        setMarquee({ start: marquee.start, current: screenToCanvas(screenPoint, viewport) })
        return
      }
      if (isPanningRef.current) {
        const screenDelta = {
          x: screenPoint.x - lastPanPointRef.current.x,
          y: screenPoint.y - lastPanPointRef.current.y,
        }
        lastPanPointRef.current = screenPoint
        setViewport((vp) => panBy(vp, screenDelta))
        return
      }
      if (gestureState.kind === 'idle') return
      const point = screenToCanvas(screenPoint, viewport)
      setLivePoint(point)
      applyResult(reduceGesture(gestureState, canvas, { type: 'pointermove', point }))
    }

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const root = rootRef.current
      activePointerIdRef.current = null
      const armed = doublePressRef.current
      doublePressRef.current = null
      if (marquee !== null) {
        setMarquee(null)
        const zeroMove =
          marquee.start.x === marquee.current.x && marquee.start.y === marquee.current.y
        if (zeroMove) {
          // A stationary empty press: a plain one just cleared selection at
          // the press; a DOUBLE one creates a node here (resolved at the
          // release, consistent with the node-edit double-press rule).
          if (armed !== null && armed.key === 'empty') createNodeAt(armed.point)
          return
        }
        const rect = {
          x: Math.min(marquee.start.x, marquee.current.x),
          y: Math.min(marquee.start.y, marquee.current.y),
          w: Math.abs(marquee.current.x - marquee.start.x),
          h: Math.abs(marquee.current.y - marquee.start.y),
        }
        const hitIds = boxes
          .filter(
            (entry) =>
              entry.box.x < rect.x + rect.w &&
              entry.box.x + entry.box.width > rect.x &&
              entry.box.y < rect.y + rect.h &&
              entry.box.y + entry.box.height > rect.y,
          )
          .map((entry) => entry.id)
        const [primary, ...rest] = hitIds
        setSelectedId(primary ?? null)
        setExtraIds(new Set(rest))
        return
      }
      if (isPanningRef.current) {
        isPanningRef.current = false
        return
      }
      if (root === null) return
      const screenPoint = clientPointToRootLocal(e, root)
      const point = screenToCanvas(screenPoint, viewport)
      const targetNodeId = gestureState.kind === 'connecting' ? hitTest(boxes, point) : undefined
      const result = reduceGesture(
        gestureState,
        canvas,
        { type: 'pointerup', point, targetNodeId },
        { createId },
      )
      // A move commit on a multi-selection member applies the SAME delta to
      // every other member — expanded here at commit time so the reducer
      // keeps its single-node contract.
      // A double press on a node that never moved is double-click-to-edit.
      if (
        armed !== null &&
        gestureState.kind === 'moving' &&
        armed.key === gestureState.nodeId &&
        result.commands.length === 0
      ) {
        const node = canvasRef.current.nodes.find((n) => n.id === gestureState.nodeId)
        if (node?.type === 'text') {
          applyResult(
            reduceGesture(result.state, canvas, {
              type: 'start-text-edit',
              nodeId: node.id,
              text: node.text,
            }),
          )
          return
        }
      }
      const moved = result.commands.find((c) => c.kind === 'move-node')
      if (moved !== undefined && extraIds.size > 0 && gestureState.kind === 'moving') {
        const dx = moved.x - gestureState.startX
        const dy = moved.y - gestureState.startY
        const extras = [...extraIds]
          .filter((id) => id !== moved.id)
          .flatMap((id) => {
            const node = canvasRef.current.nodes.find((n) => n.id === id)
            return node === undefined
              ? []
              : [{ kind: 'move-node' as const, id, x: node.x + dx, y: node.y + dy }]
          })
        applyResult({ ...result, commands: [...result.commands, ...extras] })
        return
      }
      applyResult(result)
    }

    const handlePointerCancel = () => {
      isPanningRef.current = false
      activePointerIdRef.current = null
      applyResult(reduceGesture(gestureState, canvas, { type: 'pointercancel' }))
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Keyboard equivalent of pointercancel: discards an in-flight
      // resize/move/connect gesture without committing it.
      if (e.key === 'Escape' && gestureState.kind !== 'idle') {
        e.preventDefault()
        applyResult(reduceGesture(gestureState, canvas, { type: 'pointercancel' }))
        return
      }
      // Delete/Backspace deletes the current selection — but never while the
      // event's own target is a text-entry surface (the open TextNodeEditor's
      // textarea, or any other input this root might contain), or Backspace
      // while typing would delete the node instead of a character. The
      // reducer's own editing-text guard is the second, machine-checkable
      // layer of that same policy (see gestures.ts's delete-selection arm).
      // Arrow keys nudge the SELECTED node (standard canvas-tool parity);
      // Shift multiplies the step. A focused resize handle handles arrows
      // itself and stops propagation there, so an arrow reaching THIS
      // handler is never a resize.
      if (e.key === ' ' && gestureState.kind === 'idle') {
        // Held Space turns the next left-drag into a pan (Excalidraw
        // semantics). preventDefault stops the page scrolling on Space.
        e.preventDefault()
        spaceDownRef.current = true
        return
      }
      const nudge = ARROW_KEY_DELTA[e.key]
      if (
        nudge !== undefined &&
        selection !== undefined &&
        selectedNode !== undefined &&
        gestureState.kind === 'idle'
      ) {
        e.preventDefault()
        const step = e.shiftKey ? RESIZE_KEYBOARD_STEP_LARGE : RESIZE_KEYBOARD_STEP
        // Read the node's position from canvasRef, not the render closure:
        // key auto-repeat delivers keydowns faster than commits re-render,
        // and a stale base makes each repeat clobber the previous nudge.
        const current = canvasRef.current.nodes.find((n) => n.id === selectedNode.id)
        if (current === undefined) return
        applyResult({
          state: gestureState,
          commands: [
            {
              kind: 'move-node',
              id: current.id,
              x: current.x + nudge.dx * step,
              y: current.y + nudge.dy * step,
            },
          ],
        })
        return
      }
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        selection !== undefined &&
        extraIds.size > 0 &&
        gestureState.kind !== 'editing-text'
      ) {
        e.preventDefault()
        const ids = [selection.id, ...extraIds]
        applyResult({
          state: { kind: 'idle' },
          commands: ids.map((id) => ({ kind: 'delete-node' as const, id })),
          selectedId: null,
        })
        setExtraIds(new Set())
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection !== undefined) {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
        e.preventDefault()
        applyResult(
          reduceGesture(gestureState, canvas, { type: 'delete-selection', nodeId: selection.id }),
        )
      }
    }

    const handleResizeHandleKeyDown = (
      handle: ResizeHandleKind,
      _handleBox: Box,
      e: React.KeyboardEvent,
    ) => {
      if (selection === undefined) return
      // The resize anchor is the NODE's box, not the handle's own tiny
      // hit-box `_handleBox` describes — same reasoning as
      // onHandlePointerDown's `box: selection.box` below.
      const box = selection.box
      const step = e.shiftKey ? RESIZE_KEYBOARD_STEP_LARGE : RESIZE_KEYBOARD_STEP
      const delta = ARROW_KEY_DELTA[e.key]
      if (delta === undefined) return
      e.preventDefault()
      const nextBox = resizeBoxByDelta(box, handle, delta.dx * step, delta.dy * step)
      if (
        nextBox.x === box.x &&
        nextBox.y === box.y &&
        nextBox.width === box.width &&
        nextBox.height === box.height
      ) {
        return
      }
      const command: EditorCommand = {
        kind: 'resize-node',
        id: selection.id,
        x: nextBox.x,
        y: nextBox.y,
        width: nextBox.width,
        height: nextBox.height,
      }
      onChange(applyCommand(canvasRef.current, command), command)
    }

    const handleConnectKeyDown = () => {
      if (selection === undefined) return
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'pointerdown-connect', nodeId: selection.id }),
      )
    }

    const handleWheel = (e: WheelEvent) => {
      const root = rootRef.current
      if (root === null) return
      // React registers onWheel as a PASSIVE listener (matching the browser's
      // own default for scroll-affecting events), so e.preventDefault() from a
      // React handler is silently ignored. Ctrl/Cmd+wheel zoom needs to
      // suppress the browser's own page-zoom/scroll, which only a
      // { passive: false } NATIVE listener can do — see the effect below that
      // wires this function up that way.
      e.preventDefault()
      const screenPoint = clientPointToRootLocal(e, root)
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR
        setViewport((vp) => zoomAt(vp, screenPoint, factor))
        return
      }
      // A scroll wheel moves the CONTENT opposite to a drag of the same sign,
      // hence the negated delta.
      setViewport((vp) => panBy(vp, { x: -e.deltaX, y: -e.deltaY }))
    }

    const handleWheelRef = useRef(handleWheel)
    handleWheelRef.current = handleWheel

    useEffect(() => {
      const root = rootRef.current
      if (root === null) return
      const onWheel = (e: WheelEvent) => handleWheelRef.current(e)
      root.addEventListener('wheel', onWheel, { passive: false })
      return () => root.removeEventListener('wheel', onWheel)
    }, [])

    // Unmount-mid-gesture safety net. Every pointer handler above is a JSX
    // prop (the wheel listener is this component's only native one, and it
    // already cleans itself up), so React tears them all down with the
    // component and no stale handler can fire an onChange/command after
    // this point — that half of "no listener leak" is structural, not
    // something this effect needs to do. What React does NOT do for us is
    // release pointer capture the platform is still holding on our behalf;
    // an unmount mid-drag (route change, a parent swapping this component
    // out) would otherwise leave the browser holding capture for a pointer
    // no element can any longer respond to. Best-effort/never-throw, same
    // reasoning as `trySetPointerCapture`.
    useEffect(() => {
      // Capture the root HERE, at mount, rather than reading `rootRef.current`
      // inside the cleanup closure: React detaches the ref (sets it to
      // `null`) before this cleanup runs on unmount, so reading the ref at
      // cleanup time would always see `null` and silently skip the release.
      const root = rootRef.current
      return () => {
        const pointerId = activePointerIdRef.current
        if (root === null || pointerId === null) return
        try {
          root.releasePointerCapture(pointerId)
        } catch {
          // best-effort — see doc comment above
        }
      }
    }, [])

    /** Creates a text node centered on `point` (canvas space) and opens it for typing. */
    const createNodeAt = (point: Point) => {
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'dblclick-empty', point }, { createId }),
      )
    }

    /**
     * The button path (unlike double-click, whose point comes straight from
     * the pointer) always resolves to the same viewport-center point, so
     * without a placement rule every click here would stack an identical,
     * unreachable rect on the last one. `findFreeSpot` cascades off the
     * CURRENT node boxes (read from `canvasRef.current`, not the possibly-
     * stale `canvas` prop) so two rapid clicks still see each other's result.
     */
    const createNodeAtViewportCenter = () => {
      const root = rootRef.current
      const centerScreen =
        root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
      const preferred = screenToCanvas(centerScreen, viewport)
      const occupied = indexNodeBoxes(canvasRef.current).map((b) => b.box)
      const point = findFreeSpot(
        preferred,
        { width: NEW_NODE_WIDTH, height: NEW_NODE_HEIGHT },
        occupied,
      )
      createNodeAt(point)
    }

    return (
      <div
        ref={rootRef}
        data-testid={testId}
        className={className}
        // A canvas editor's interaction surface has no static-content semantics
        // HTML/ARIA can describe more precisely than "application" — this is
        // the same documented tradeoff drawing/whiteboard editors commonly
        // make. A dedicated a11y parallel-DOM projection is future work, not
        // this slice's scope.
        role="application"
        aria-label="Spatial canvas editor"
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onContextMenu={handleContextMenu}
        onKeyUp={(e) => {
          if (e.key === ' ') spaceDownRef.current = false
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
        {/* The OOUI creation surface: every canvas is empty until a node
          exists and double-click-empty-space has no visible cue, so the
          palette is the always-visible, keyboard-reachable way in. Fixed to
          the bottom edge outside the pan/zoom transform. */}
        <ToolPalette onCreateNode={createNodeAtViewportCenter} tool={tool} onToolChange={setTool} />
        {contextMenu !== null && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            items={(() => {
              const node =
                contextMenu.nodeId === undefined
                  ? undefined
                  : canvas.nodes.find((n) => n.id === contextMenu.nodeId)
              if (node === undefined) {
                return [{ label: 'Add note here', onSelect: () => createNodeAt(contextMenu.point) }]
              }
              const items = []
              if (node.type === 'text') {
                items.push({
                  label: 'Edit text',
                  onSelect: () => {
                    applyResult(
                      reduceGesture(gestureState, canvas, {
                        type: 'start-text-edit',
                        nodeId: node.id,
                        text: node.text,
                      }),
                    )
                  },
                })
              }
              items.push({
                label: 'Delete',
                danger: true,
                onSelect: () => {
                  applyResult(
                    reduceGesture(gestureState, canvas, {
                      type: 'delete-selection',
                      nodeId: node.id,
                    }),
                  )
                },
              })
              return items
            })()}
          />
        )}
        <div
          data-testid="viewport-transform"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: viewportTransformCss(viewport),
            transformOrigin: '0 0',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: bounds.x,
              top: bounds.y,
              // canvas-render's layoutMdastBlocks assigns no appearance to
              // markdown body text runs (they carry no `fill` attribute at
              // all), so they inherit this host element's SVG `fill`
              // instead — the seam that keeps body text visible on the dark
              // canvas surface without editing canvas-render itself. Any
              // element that DOES carry its own `fill` presentation
              // attribute is unaffected (presentation attributes win over
              // an inherited value).
              fill: editorTextFill(theme),
            }}
            // canvas-render's SVG serializer is the SOLE producer of this
            // string and escapes text/attrs (see svg/format.ts) — the same
            // already-reviewed reasoning as CanvasViewer.tsx's identical sink.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          {marquee !== null && (
            <svg
              data-testid="marquee-rect"
              aria-hidden="true"
              style={{
                position: 'absolute',
                overflow: 'visible',
                left: 0,
                top: 0,
                pointerEvents: 'none',
              }}
            >
              <rect
                x={Math.min(marquee.start.x, marquee.current.x)}
                y={Math.min(marquee.start.y, marquee.current.y)}
                width={Math.abs(marquee.current.x - marquee.start.x)}
                height={Math.abs(marquee.current.y - marquee.start.y)}
                fill="#2563eb"
                fillOpacity={0.08}
                stroke="#2563eb"
                strokeWidth={1 / viewport.zoom}
                strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`}
              />
            </svg>
          )}
          {extraIds.size > 0 && (
            <svg
              data-testid="extra-selection-outlines"
              aria-hidden="true"
              style={{
                position: 'absolute',
                overflow: 'visible',
                left: 0,
                top: 0,
                pointerEvents: 'none',
              }}
            >
              {[...extraIds].flatMap((id) => {
                const b = boxes.find((entry) => entry.id === id)
                return b === undefined ? (
                  []
                ) : (
                  <rect
                    key={id}
                    x={b.box.x}
                    y={b.box.y}
                    width={b.box.width}
                    height={b.box.height}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth={1.5 / viewport.zoom}
                    opacity={0.7}
                  />
                )
              })}
            </svg>
          )}
          {selection !== undefined && (
            <SelectionOverlay
              box={selection.box}
              zoom={viewport.zoom}
              onHandlePointerDown={(handle, _handleBox, e) => {
                const root = beginOverlayGesture(e)
                if (root === null) return
                const point = screenToCanvas(clientPointToRootLocal(e, root), viewport)
                applyResult(
                  reduceGesture(gestureState, canvas, {
                    type: 'pointerdown-handle',
                    nodeId: selection.id,
                    handle,
                    point,
                    // The resize anchor is the NODE's box, not the handle's own
                    // tiny hit-box `_handleBox` describes — using the handle
                    // box here would seed `reducePointerUpResizing`'s
                    // anchor-preserving math from an 8px square instead of the
                    // node, growing/shrinking from the wrong origin.
                    box: selection.box,
                  }),
                )
              }}
              onConnectPointerDown={(e) => {
                if (beginOverlayGesture(e) === null) return
                applyResult(
                  reduceGesture(gestureState, canvas, {
                    type: 'pointerdown-connect',
                    nodeId: selection.id,
                  }),
                )
              }}
              onHandleKeyDown={handleResizeHandleKeyDown}
              onConnectKeyDown={handleConnectKeyDown}
              onEditRequest={
                selectedNode?.type === 'text'
                  ? () => {
                      applyResult(
                        reduceGesture(gestureState, canvas, {
                          type: 'start-text-edit',
                          nodeId: selectedNode.id,
                          text: selectedNode.text,
                        }),
                      )
                    }
                  : undefined
              }
            />
          )}
          {/* In-flight gesture preview. Drawn from component-local pointer
            state above the committed SVG, so the expensive
            layout+stringify+innerHTML path runs once per gesture (at
            pointerup) instead of once per frame. */}
          {dragPreview !== undefined && (
            <DragPreviewLayer
              preview={dragPreview}
              zoom={viewport.zoom}
              contentSvg={dragContentSvg}
            />
          )}
          {gestureState.kind === 'connecting' && (
            <svg
              style={{
                position: 'absolute',
                overflow: 'visible',
                left: 0,
                top: 0,
                pointerEvents: 'none',
              }}
            >
              <title>Connection targets</title>
              {/* Named rather than aria-hidden for the same reason as the
                selection overlay: this subtree holds the focusable connection
                targets, so hiding it would remove the keyboard path. */}
              {/*
               * Keyboard path for completing a connection: while `connecting`,
               * every OTHER node gets a focusable target the pointer path
               * already reaches by hit-testing on pointerup. Tab to one and
               * press Enter/Space, matching `reducePointerUpConnecting`'s
               * targetNodeId contract exactly (invalid targets are the
               * fromNode itself, which is excluded below).
               */}
              {boxes
                .filter((b) => b.id !== gestureState.fromNodeId)
                .map((b) => (
                  // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to hit-test at this node's canvas-space box under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
                  <rect
                    key={b.id}
                    data-testid={`connect-target-${b.id}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Connect to node ${b.id}`}
                    x={b.box.x}
                    y={b.box.y}
                    width={b.box.width}
                    height={b.box.height}
                    fill="transparent"
                    style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      applyResult(
                        reduceGesture(
                          gestureState,
                          canvas,
                          {
                            type: 'pointerup',
                            point: { x: b.box.x, y: b.box.y },
                            targetNodeId: b.id,
                          },
                          { createId },
                        ),
                      )
                    }}
                  />
                ))}
            </svg>
          )}
          {gestureState.kind === 'editing-text' &&
            selectedNode?.type === 'text' &&
            selection !== undefined && (
              <TextNodeEditor
                box={selection.box}
                initialText={selectedNode.text}
                onCommit={(text) => {
                  applyResult(
                    reduceGesture(gestureState, canvas, { type: 'commit-text-edit', text }),
                  )
                }}
                onCancel={() => {
                  applyResult(reduceGesture(gestureState, canvas, { type: 'cancel-text-edit' }))
                }}
                onChange={(text) => {
                  applyResult(
                    reduceGesture(gestureState, canvas, { type: 'update-text-edit', text }),
                  )
                }}
              />
            )}
        </div>
      </div>
    )
  },
)
