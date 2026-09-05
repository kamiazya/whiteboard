/**
 * In-flight connect gesture: an indicator on the source node plus a
 * focusable connect-target per other node, reached by Tab then Enter/Space
 * (matching `reducePointerUpConnecting`'s `targetNodeId` contract).
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import { type GestureResult, type GestureState, reduceGesture } from './gestures.js'

export interface ConnectOverlayProps {
  readonly gestureState: Extract<GestureState, { kind: 'connecting' }>
  readonly canvas: SpatialCanvas
  readonly boxes: readonly NodeBox[]
  readonly selectableBoxes: readonly NodeBox[]
  readonly createId?: () => string
  readonly applyResult: (result: GestureResult) => void
}

export function ConnectOverlay({
  gestureState,
  canvas,
  boxes,
  selectableBoxes,
  createId,
  applyResult,
}: ConnectOverlayProps) {
  return (
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
      {/* Immediate acknowledgment that the connect ARMED: the
        rubber-band line only appears once the pointer moves, so a
        still hand needs the source node marked right away. */}
      {(() => {
        const source = boxes.find((b) => b.id === gestureState.fromNodeId)
        if (source === undefined) return null
        return (
          <rect
            data-testid="connect-source-indicator"
            x={source.box.x - 2}
            y={source.box.y - 2}
            width={source.box.width + 4}
            height={source.box.height + 4}
            fill="none"
            stroke="var(--manipulation)"
            strokeWidth={2}
            strokeDasharray="6 3"
          />
        )
      })()}
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
      {selectableBoxes
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
  )
}
