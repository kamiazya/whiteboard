import type { CanvasEdge, CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { isFreehandStroke } from '../../lib/spatial/freehand.js'
import { hitTest, type NodeBox } from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'
import { BoxTargetOverlay } from './BoxTargetOverlay.js'
import type { ContextMenuTarget } from './CanvasContextMenu.js'
import { EdgeBendLayer } from './EdgeBendLayer.js'
import { EdgeEndHandles } from './EdgeEndHandles.js'
import { EdgeSelectionHighlight } from './EdgeSelectionHighlight.js'
import type { EditorGesture } from './editor-gesture.js'
import { otherEndNodeOf } from './gesture-ends.js'
import { PathMoreActions, pathMenuTarget } from './PathMoreActions.js'

export interface RoutableHandlesProps {
  readonly gesture: EditorGesture
  readonly selectedInkIds: readonly string[]
  /** The single selected element that has a path of its own to handle. */
  readonly selectedRoutable: CanvasEdge | CanvasLine | undefined
  readonly edgePaths: readonly { readonly id: string; readonly path: readonly Point[] }[]
  readonly edgePathOf: (edgeId: string) => readonly Point[] | undefined
  readonly boxes: readonly NodeBox[]
  readonly selectableBoxes: readonly NodeBox[]
  readonly createId: (() => string) | undefined
  /** Where the selection's more-actions chip opens its menu, and how wide the editor is. */
  readonly menu?: {
    readonly open: (target: ContextMenuTarget) => void
    readonly root: { readonly width: number; readonly height: number }
  }
}

/**
 * The handles for whatever is selected that has a PATH: an ink stroke's
 * bends, an edge's ends, and the live connect/reattach preview.
 */
export function RoutableHandles(props: RoutableHandlesProps) {
  const { gesture, selectedInkIds, selectedRoutable } = props
  const { state } = gesture
  return (
    <>
      {selectedInkIds.length > 0 && (
        <EdgeSelectionHighlight
          selectedEdgeIds={selectedInkIds}
          edgePaths={props.edgePaths}
          offset={inkDragOffset(gesture)}
        />
      )}
      {props.menu !== undefined && state.kind === 'idle' && (
        <MoreActionsChip {...props} menu={props.menu} />
      )}
      {selectedRoutable !== undefined && (
        <PathHandles
          gesture={gesture}
          element={selectedRoutable}
          path={props.edgePathOf(selectedRoutable.id) ?? []}
        />
      )}
      {(state.kind === 'connecting' || state.kind === 'reattaching') && (
        <ConnectTargets {...props} state={state} />
      )}
    </>
  )
}

function MoreActionsChip({
  gesture,
  selectedInkIds,
  selectedRoutable,
  edgePaths,
  edgePathOf,
  menu,
}: RoutableHandlesProps & { readonly menu: NonNullable<RoutableHandlesProps['menu']> }) {
  const [lead] = selectedInkIds
  if (lead === undefined) return null
  const paths = edgePaths.filter((entry) => selectedInkIds.includes(entry.id))
  const { viewport } = gesture
  return (
    <PathMoreActions
      paths={paths.map((entry) => entry.path)}
      handles={handlesOf(selectedRoutable, edgePathOf)}
      visible={{
        x: viewport.x,
        y: viewport.y,
        width: menu.root.width / viewport.zoom,
        height: menu.root.height / viewport.zoom,
      }}
      zoom={viewport.zoom}
      subject={pathSubject(gesture.canvas, selectedInkIds)}
      onOpen={(anchor) => menu.open(pathMenuTarget(lead, anchor, viewport, menu.root.width))}
    />
  )
}

/**
 * Where `PathHandles` draws a grab point for this element: its two ends,
 * and — unless it is a drawing, which offers no bends — its stored bends.
 * The ghost points a new bend is pulled from sit mid-run, away from the
 * corners the chip is placed at.
 */
function handlesOf(
  element: CanvasEdge | CanvasLine | undefined,
  edgePathOf: RoutableHandlesProps['edgePathOf'],
): readonly Point[] {
  if (element === undefined) return []
  const path = edgePathOf(element.id) ?? []
  const first = path[0]
  const last = path[path.length - 1]
  if (first === undefined || last === undefined) return []
  if (isFreehandStroke(element)) return [first, last]
  return [first, last, ...(element.bends ?? [])]
}

/**
 * What a selected path is called aloud. A drawn stroke is a drawing and a
 * relation a connection (vocabulary: a Line is not an Edge), and a ruled
 * line is neither.
 */
function pathSubject(canvas: SpatialCanvas, ids: readonly string[]): string {
  if (ids.length > 1) return `${ids.length} selected items`
  const line = (canvas.lines ?? []).find((entry) => entry.id === ids[0])
  if (line === undefined) return 'this connection'
  return isFreehandStroke(line) ? 'this drawing' : 'this line'
}

/**
 * The live half of the ink drag: the committed strokes stay where they are
 * and their outlines travel, which is the same bargain the node drag makes
 * with its ghost box. A full re-layout per frame is what the preview overlay
 * exists to avoid (see `drag-preview.ts`'s header).
 */
function inkDragOffset({ state, livePoint }: EditorGesture): Point | undefined {
  if (state.kind !== 'moving-ink') return undefined
  return {
    x: (livePoint?.x ?? state.startPoint.x) - state.startPoint.x,
    y: (livePoint?.y ?? state.startPoint.y) - state.startPoint.y,
  }
}

/** A selected edge's or stroke's end handles and bend layer. */
function PathHandles({
  gesture,
  element,
  path,
}: {
  readonly gesture: EditorGesture
  readonly element: CanvasEdge | CanvasLine
  readonly path: readonly Point[]
}) {
  return (
    <>
      <EdgeEndHandles
        path={path}
        zoom={gesture.viewport.zoom}
        subject={pathSubject(gesture.canvas, [element.id])}
        onArm={(endpoint, event) => {
          if (event !== undefined) gesture.beginOverlay(event)
          gesture.dispatch({ type: 'pointerdown-end', elementId: element.id, endpoint })
        }}
      />
      {/* A drawing's bends are where the hand went, and a press on the
        stroke has to MOVE it: grab points every few pixels along it left no
        part of a selected drawing a finger could press without bending it. */}
      {!isFreehandStroke(element) && (
        <EdgeBendLayer
          edge={element}
          path={path}
          viewport={gesture.viewport}
          begin={gesture.beginOverlay}
          dispatch={gesture.dispatch}
        />
      )}
    </>
  )
}

/** The boxes a connect or a reattach could land on, while one is live. */
function ConnectTargets({
  gesture,
  state,
  boxes,
  selectableBoxes,
  createId,
}: RoutableHandlesProps & {
  readonly state: Extract<EditorGesture['state'], { kind: 'connecting' | 'reattaching' }>
}) {
  const { canvas, livePoint } = gesture
  return (
    <BoxTargetOverlay
      gestureState={state}
      sourceNodeId={
        state.kind === 'connecting'
          ? state.fromNodeId
          : // The box the OTHER end is on, which this end may not land on
            // either: the write refuses a self-loop, so offering it as a
            // target would offer a no-op.
            otherEndNodeOf(canvas, state.elementId, state.endpoint)
      }
      hoveredNodeId={livePoint === null ? undefined : hitTest(selectableBoxes, livePoint)}
      canvas={canvas}
      boxes={boxes}
      selectableBoxes={selectableBoxes}
      {...(createId === undefined ? {} : { createId })}
      applyResult={gesture.apply}
    />
  )
}
