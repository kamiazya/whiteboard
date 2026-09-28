import type { CanvasEdge, CanvasLine } from '@kamiazya/whiteboard-model'
import { hitTest, type NodeBox } from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'
import { BoxTargetOverlay } from './BoxTargetOverlay.js'
import { EdgeBendLayer } from './EdgeBendLayer.js'
import { EdgeEndHandles } from './EdgeEndHandles.js'
import { EdgeSelectionHighlight } from './EdgeSelectionHighlight.js'
import type { EditorGesture } from './editor-gesture.js'
import { otherEndNodeOf } from './gesture-ends.js'

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
        onArm={(endpoint, event) => {
          if (event !== undefined) gesture.beginOverlay(event)
          gesture.dispatch({ type: 'pointerdown-end', elementId: element.id, endpoint })
        }}
      />
      <EdgeBendLayer
        edge={element}
        path={path}
        viewport={gesture.viewport}
        begin={gesture.beginOverlay}
        dispatch={gesture.dispatch}
      />
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
