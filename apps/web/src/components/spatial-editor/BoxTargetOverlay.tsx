/**
 * The boxes an armed gesture can land on: an indicator on the box it
 * started from plus a focusable target per other box, reached by Tab then
 * Enter/Space.
 *
 * Serves BOTH gestures that end by naming a box — connecting, which makes
 * an element, and re-attaching, which moves one's end. They ask the same
 * question and the release contract is literally the same event, so the
 * targets are shared rather than copied: a second copy is a second chance
 * for one of them to stop offering the keyboard path.
 *
 * It was `ConnectOverlay` while connecting was its only caller. The name
 * said what armed it rather than what it offers, which is the thing two
 * callers made wrong.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import { type GestureResult, type GestureState, reduceGesture } from './gestures.js'

export interface BoxTargetOverlayProps {
  readonly gestureState: Extract<GestureState, { kind: 'connecting' | 'reattaching' }>
  /**
   * The box the gesture started from: the connect source, or the box the
   * element's OTHER end is on. It is marked rather than offered, and is
   * `undefined` when there is none — a stroke's other end may be a free
   * point, and then every box is a target.
   */
  readonly sourceNodeId: string | undefined
  /**
   * The box the pointer is over, outlined so the drag says where it would
   * land. Only the OUTLINE is drawn and never an attachment point: where an
   * end meets a box is the router's, and a preview that guessed would imply
   * a geometry the commit then contradicts.
   */
  readonly hoveredNodeId?: string | undefined
  readonly canvas: SpatialCanvas
  readonly boxes: readonly NodeBox[]
  readonly selectableBoxes: readonly NodeBox[]
  readonly createId?: () => string
  readonly applyResult: (result: GestureResult) => void
}

export function BoxTargetOverlay({
  gestureState,
  sourceNodeId,
  hoveredNodeId,
  canvas,
  boxes,
  selectableBoxes,
  createId,
  applyResult,
}: BoxTargetOverlayProps) {
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
      <title>Boxes this can attach to</title>
      {/* Immediate acknowledgment that the connect ARMED: the
        rubber-band line only appears once the pointer moves, so a
        still hand needs the source node marked right away. */}
      {(() => {
        const source = boxes.find((b) => b.id === sourceNodeId)
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
       * Keyboard path for completing the gesture: every OTHER box gets
       * a focusable target the pointer path already reaches by
       * hit-testing on pointerup. Tab to one and press Enter/Space,
       * dispatching exactly the `pointerup` + `targetNodeId` both
       * release arms take (the source box itself is excluded below).
       */}
      {selectableBoxes
        .filter((b) => b.id !== sourceNodeId)
        .map((b) => (
          // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to hit-test at this node's canvas-space box under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
          <rect
            key={b.id}
            data-testid={`connect-target-${b.id}`}
            role="button"
            tabIndex={0}
            aria-label={`Attach to node ${b.id}`}
            x={b.box.x}
            y={b.box.y}
            width={b.box.width}
            height={b.box.height}
            fill="transparent"
            {...(b.id === hoveredNodeId
              ? {
                  'data-hovered': 'true',
                  stroke: 'var(--manipulation)',
                  strokeWidth: 2,
                }
              : {})}
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
