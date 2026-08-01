/**
 * A read-write editor for a `SpatialCanvas`, built on canvas-render's
 * `layoutSpatialCanvas` + `renderSceneToSvg` (the same scene builder
 * canvas-viewer's read-only `CanvasViewer` uses — this is NOT a fourth
 * scene builder).
 *
 * Supported: display, pan, zoom, select (click / click-empty-to-clear),
 * move (drag a selected node), resize (drag a corner/edge handle,
 * anchor-preserving), edit text (double-click a text node; commits on
 * blur/Cmd+Enter, Escape cancels), connect an edge (drag from a selected
 * node's connect handle onto another node).
 *
 * The component is CONTROLLED and owns no persistence: every mutating
 * gesture calls `onChange(next, command)` with a brand-new `SpatialCanvas`
 * value (see `commands.ts`) — it never mutates the `canvas` prop.
 *
 * NOT yet supported (see `SPATIAL_EDITOR_UNSUPPORTED`): freehand drawing
 * and shape tools (`x-whiteboard` extension authoring — its own slice),
 * multi-select, grouping, undo/redo, arrow-side pinning, snapping,
 * persistence, and sync. Those are later phases.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorCommand } from './commands.js'
import { applyCommand } from './commands.js'
import { hitTest, indexNodeBoxes } from './geometry.js'
import type { GestureState } from './gestures.js'
import { createIdleState, reduceGesture } from './gestures.js'
import { SelectionOverlay } from './SelectionOverlay.js'
import { renderCanvasToSvg } from './scene-render.js'
import { TextNodeEditor } from './TextNodeEditor.js'
import {
  clampZoom,
  IDENTITY_VIEWPORT,
  screenToCanvas,
  type Viewport,
  viewportTransformCss,
} from './viewport.js'

/**
 * Machine-checkable out-of-scope list this slice deliberately does not
 * implement — referenced above and asserted by `doc-contract.test.ts`.
 */
export const SPATIAL_EDITOR_UNSUPPORTED = [
  'freehand-drawing',
  'shape-tools',
  'multi-select',
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
  /** Injection seam for tests; defaults to the real Canvas 2D measurer. */
  readonly measure?: MeasureText
  /** Injection seam for deterministic edge-id tests; defaults to crypto.randomUUID. */
  readonly createId?: () => string
  readonly className?: string
  readonly testId?: string
}

const DEFAULT_TEST_ID = 'spatial-editor'
const ZOOM_WHEEL_FACTOR = 1.1

function clientPointToRootLocal(e: { clientX: number; clientY: number }, root: HTMLElement) {
  const rect = root.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

/**
 * Pointer capture is best-effort chrome, not a correctness requirement: a
 * browser can reject it (e.g. `NotFoundError` for a pointerId the platform
 * has no active record of, which synthetic/programmatic pointer dispatch
 * can trigger). Swallowing this keeps the gesture usable via window-level
 * move/up delivery instead of aborting the whole interaction.
 */
function trySetPointerCapture(root: HTMLElement, pointerId: number): void {
  try {
    root.setPointerCapture(pointerId)
  } catch {
    // best-effort — see doc comment above
  }
}

export function SpatialEditor({
  canvas,
  onChange,
  measure,
  createId,
  className,
  testId = DEFAULT_TEST_ID,
}: SpatialEditorProps) {
  const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])
  const rootRef = useRef<HTMLDivElement | null>(null)

  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [gestureState, setGestureState] = useState<GestureState>(createIdleState())
  const isPanningRef = useRef(false)
  const lastPanPointRef = useRef({ x: 0, y: 0 })

  const canvasRef = useRef(canvas)
  const prevCanvasRef = useRef(canvas)
  canvasRef.current = canvas

  // Controlled-prop-swap policy: a sync-driven parent can replace `canvas`
  // mid-gesture. Feed the reducer a `canvas-replaced` event so it can abort
  // or continue per gestures.ts's documented contract.
  useEffect(() => {
    if (prevCanvasRef.current === canvas) return
    prevCanvasRef.current = canvas
    const result = reduceGesture(gestureState, canvas, { type: 'canvas-replaced', canvas })
    setGestureState(result.state)
    // gestureState intentionally omitted: this effect only reacts to a new
    // canvas identity, not every gestureState transition (that would create
    // an infinite render loop feeding the reducer's own output back in).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas])

  const { svg, bounds } = useMemo(
    () => renderCanvasToSvg(canvas, { measure: resolvedMeasure }),
    [canvas, resolvedMeasure],
  )
  const boxes = useMemo(() => indexNodeBoxes(canvas), [canvas])
  const selectedBox = useMemo(
    () => (selectedId === null ? undefined : boxes.find((b) => b.id === selectedId)?.box),
    [boxes, selectedId],
  )
  const selectedNode = useMemo(
    () => (selectedId === null ? undefined : canvas.nodes.find((n) => n.id === selectedId)),
    [canvas, selectedId],
  )

  const applyResult = (result: ReturnType<typeof reduceGesture>) => {
    setGestureState(result.state)
    if (result.selectedId !== undefined) setSelectedId(result.selectedId)
    if (result.command !== undefined) {
      onChange(applyCommand(canvasRef.current, result.command), result.command)
    }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const root = rootRef.current
    if (root === null) return
    trySetPointerCapture(root, e.pointerId)
    const screenPoint = clientPointToRootLocal(e, root)
    const point = screenToCanvas(screenPoint, viewport)
    const hitId = hitTest(boxes, point)
    if (hitId === undefined) {
      isPanningRef.current = true
      lastPanPointRef.current = screenPoint
      applyResult(reduceGesture(gestureState, canvas, { type: 'pointerdown-empty' }))
      return
    }
    applyResult(reduceGesture(gestureState, canvas, { type: 'pointerdown', nodeId: hitId, point }))
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (root === null) return
    const screenPoint = clientPointToRootLocal(e, root)
    if (isPanningRef.current) {
      const dx = screenPoint.x - lastPanPointRef.current.x
      const dy = screenPoint.y - lastPanPointRef.current.y
      lastPanPointRef.current = screenPoint
      setViewport((vp) => ({ ...vp, x: vp.x - dx / vp.zoom, y: vp.y - dy / vp.zoom }))
      return
    }
    if (gestureState.kind === 'idle') return
    const point = screenToCanvas(screenPoint, viewport)
    applyResult(reduceGesture(gestureState, canvas, { type: 'pointermove', point }))
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (isPanningRef.current) {
      isPanningRef.current = false
      return
    }
    if (root === null) return
    const screenPoint = clientPointToRootLocal(e, root)
    const point = screenToCanvas(screenPoint, viewport)
    const targetNodeId = gestureState.kind === 'connecting' ? hitTest(boxes, point) : undefined
    applyResult(
      reduceGesture(
        gestureState,
        canvas,
        { type: 'pointerup', point, targetNodeId },
        { createEdgeId: createId },
      ),
    )
  }

  const handlePointerCancel = () => {
    isPanningRef.current = false
    applyResult(reduceGesture(gestureState, canvas, { type: 'pointercancel' }))
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (root === null) return
    e.preventDefault()
    const screenPoint = clientPointToRootLocal(e, root)
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR
      setViewport((vp) => {
        const anchorCanvasPoint = screenToCanvas(screenPoint, vp)
        const nextZoom = clampZoom(vp.zoom * factor)
        return {
          zoom: nextZoom,
          x: anchorCanvasPoint.x - screenPoint.x / nextZoom,
          y: anchorCanvasPoint.y - screenPoint.y / nextZoom,
        }
      })
    } else {
      setViewport((vp) => ({ ...vp, x: vp.x + e.deltaX / vp.zoom, y: vp.y + e.deltaY / vp.zoom }))
    }
  }

  const handleDoubleClick = () => {
    if (selectedNode?.type !== 'text') return
    setGestureState({ kind: 'editing-text', nodeId: selectedNode.id })
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
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transform: viewportTransformCss(viewport),
          transformOrigin: '0 0',
        }}
      >
        <div
          style={{ position: 'absolute', left: bounds.x, top: bounds.y }}
          // canvas-render's SVG serializer is the SOLE producer of this
          // string and escapes text/attrs (see svg/format.ts) — the same
          // already-reviewed reasoning as CanvasViewer.tsx's identical sink.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {selectedBox !== undefined && (
          <SelectionOverlay
            box={selectedBox}
            zoom={viewport.zoom}
            onHandlePointerDown={(handle, box, e) => {
              e.stopPropagation()
              const root = rootRef.current
              if (root === null) return
              trySetPointerCapture(root, e.pointerId)
              const point = screenToCanvas(clientPointToRootLocal(e, root), viewport)
              applyResult(
                reduceGesture(gestureState, canvas, {
                  type: 'pointerdown-handle',
                  nodeId: selectedId as string,
                  handle,
                  point,
                  box,
                }),
              )
            }}
            onConnectPointerDown={(e) => {
              e.stopPropagation()
              const root = rootRef.current
              if (root === null) return
              trySetPointerCapture(root, e.pointerId)
              applyResult(
                reduceGesture(gestureState, canvas, {
                  type: 'pointerdown-connect',
                  nodeId: selectedId as string,
                }),
              )
            }}
          />
        )}
        {gestureState.kind === 'editing-text' &&
          selectedNode?.type === 'text' &&
          selectedBox !== undefined && (
            <TextNodeEditor
              box={selectedBox}
              initialText={selectedNode.text}
              onCommit={(text) => {
                applyResult(reduceGesture(gestureState, canvas, { type: 'commit-text-edit', text }))
              }}
              onCancel={() => {
                applyResult(reduceGesture(gestureState, canvas, { type: 'cancel-text-edit' }))
              }}
            />
          )}
      </div>
    </div>
  )
}
