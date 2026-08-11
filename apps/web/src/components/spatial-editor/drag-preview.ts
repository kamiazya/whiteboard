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
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { assignEdgeAnchors, routeEdge } from '@kamiazya/whiteboard-canvas-render'
import type { Box, NodeBox } from './geometry.js'
import { hitTest, resizeBoxByDelta } from './geometry.js'
import type { GestureState } from './gestures.js'
import type { Point } from './viewport.js'

export type DragPreview =
  | { readonly kind: 'box'; readonly box: Box }
  | { readonly kind: 'line'; readonly path: readonly Point[] }

/**
 * What the connecting branch needs to preview the REAL prospective edge:
 * the canvas (existing edges take part in anchor fan-out; the routing
 * style rides on it) and the same selectable-box set the pointerup handler
 * hit-tests for its target, so preview and commit agree on what counts as
 * hovering a node.
 */
export interface ConnectPreviewContext {
  readonly canvas: SpatialCanvas
  readonly selectableBoxes: readonly NodeBox[]
}

/**
 * Returns the preview geometry for the gesture currently in flight, or
 * `undefined` when there is nothing to preview (idle/editing-text state, no
 * live pointer yet, or the gesture's target node has since disappeared from
 * `boxes` — e.g. deleted mid-drag by a canvas-replaced event). Total: never
 * throws, never returns non-finite geometry for finite inputs.
 *
 * The resize branch must keep calling `resizeBoxByDelta` — the SAME function
 * `reducePointerUpResizing` (gestures.ts) commits with at pointerup — rather
 * than reimplementing the arithmetic inline, so the preview and the eventual
 * commit cannot drift apart.
 */
export function computeDragPreview(
  gestureState: GestureState,
  boxes: readonly NodeBox[],
  livePoint: Point | null,
  connect?: ConnectPreviewContext,
): DragPreview | undefined {
  if (livePoint === null) return undefined
  switch (gestureState.kind) {
    case 'moving': {
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
    case 'resizing':
      return {
        kind: 'box',
        box: resizeBoxByDelta(
          gestureState.startBox,
          gestureState.handle,
          livePoint.x - gestureState.startPoint.x,
          livePoint.y - gestureState.startPoint.y,
        ),
      }
    case 'connecting': {
      const box = boxes.find((b) => b.id === gestureState.fromNodeId)?.box
      if (box === undefined || connect === undefined) return undefined
      // Route the PROSPECTIVE edge through the same producer the drop
      // uses (routeEdge + assignEdgeAnchors over the tentative edge set),
      // so the preview attaches where the committed edge will — the old
      // center-to-pointer line implied edges attach at the node center,
      // which fan-out, sliding, and exposed-side selection all contradict.
      const { canvas } = connect
      // Hovering the source keeps the connect armed rather than creating
      // an edge (see reducePointerUpConnecting), so it previews like empty
      // space: a phantom zero-size node at the pointer, whose every side
      // anchor IS the pointer.
      const hovered = hitTest(connect.selectableBoxes, livePoint)
      const targetId =
        hovered === undefined || hovered === gestureState.fromNodeId
          ? '__connect-pointer__'
          : hovered
      const nodes =
        targetId === '__connect-pointer__'
          ? [
              ...canvas.nodes,
              {
                id: '__connect-pointer__',
                type: 'text' as const,
                x: livePoint.x,
                y: livePoint.y,
                width: 0,
                height: 0,
                text: '',
              },
            ]
          : canvas.nodes
      const tentative = {
        id: '__connect-preview__',
        fromNode: gestureState.fromNodeId,
        toNode: targetId,
      }
      const anchors = assignEdgeAnchors(nodes, [...canvas.edges, tentative])
      const routed = routeEdge(
        nodes,
        tentative,
        canvas['x-whiteboard']?.edgeRouting?.style,
        anchors.get(tentative.id),
      )
      return { kind: 'line', path: routed.path }
    }
    default:
      return undefined
  }
}

/**
 * Every node travelling WITH an in-flight move: the grabbed node, the
 * multi-selection extras, and — when the grabbed node is a group frame —
 * its geometrically contained members (minus locked ones, which the commit
 * refuses to move). One producer shared by snapping (which must exclude
 * carried nodes as attractors), the drag ghost, and the live layers — the
 * commit path applies the same containment rule to its member moves.
 */
export function carriedWithDrag(
  canvas: SpatialCanvas,
  gesture: { readonly nodeId: string; readonly startX: number; readonly startY: number },
  extraIds: ReadonlySet<string>,
  isLocked: (id: string) => boolean,
): ReadonlySet<string> {
  const carried = new Set<string>([gesture.nodeId, ...extraIds])
  const movingNode = canvas.nodes.find((n) => n.id === gesture.nodeId)
  if (movingNode?.type === 'group') {
    for (const n of canvas.nodes) {
      if (
        !isLocked(n.id) &&
        n.x >= gesture.startX &&
        n.y >= gesture.startY &&
        n.x + n.width <= gesture.startX + movingNode.width &&
        n.y + n.height <= gesture.startY + movingNode.height
      ) {
        carried.add(n.id)
      }
    }
  }
  return carried
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
