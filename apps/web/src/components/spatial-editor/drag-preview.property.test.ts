import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { describe } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { computeDragPreview } from './drag-preview.js'
import type { NodeBox } from './geometry.js'
import type { GestureState } from './gestures.js'
import { reduceGesture } from './gestures.js'

// jsdom-layer property tests: keep numRuns modest per test-layer-selection.
const PROPERTY_PARAMS = withDefaults({ numRuns: 50 })

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const

const smallInt = fc.integer({ min: -500, max: 500 })
const positiveSize = fc.integer({ min: 0, max: 500 })
const largeSize = fc.integer({ min: 1000, max: 2000 })
const pointArb = fc.record({ x: smallInt, y: smallInt })
const boxArb = fc.record({ x: smallInt, y: smallInt, width: positiveSize, height: positiveSize })

/** `reducePointerUpMoving`/`reducePointerUpResizing` never read `canvas`. */
const EMPTY_CANVAS: SpatialCanvas = { nodes: [], edges: [] }

describe('drag-preview / commit agreement (fast-check)', () => {
  fcTest.prop([boxArb, fc.constantFrom(...HANDLES), pointArb, pointArb], PROPERTY_PARAMS)(
    'resize preview box deep-equals the box carried by the eventual resize-node command',
    (startBox, handle, startPoint, livePoint) => {
      const state: GestureState = {
        kind: 'resizing',
        nodeId: 'n1',
        startType: 'text',
        handle,
        startPoint,
        startBox,
      }
      const preview = computeDragPreview(state, [], livePoint)
      const result = reduceGesture(state, EMPTY_CANVAS, { type: 'pointerup', point: livePoint })
      const command = result.commands[0]
      if (command === undefined) {
        // Unchanged geometry: pointerup commits nothing, preview must equal
        // the untouched start box.
        return preview?.kind === 'box' && JSON.stringify(preview.box) === JSON.stringify(startBox)
      }
      return (
        command.kind === 'resize-node' &&
        preview?.kind === 'box' &&
        preview.box.x === command.x &&
        preview.box.y === command.y &&
        preview.box.width === command.width &&
        preview.box.height === command.height
      )
    },
  )

  fcTest.prop(
    [pointArb, smallInt, smallInt, positiveSize, positiveSize, pointArb],
    PROPERTY_PARAMS,
  )(
    "move preview's (x,y) equals the (x,y) of the eventual move-node command",
    (startPoint, startX, startY, width, height, livePoint) => {
      const state: GestureState = {
        kind: 'moving',
        nodeId: 'n1',
        startType: 'text',
        startPoint,
        startX,
        startY,
      }
      const boxes: readonly NodeBox[] = [{ id: 'n1', box: { x: startX, y: startY, width, height } }]
      const preview = computeDragPreview(state, boxes, livePoint)
      const result = reduceGesture(state, EMPTY_CANVAS, { type: 'pointerup', point: livePoint })
      const command = result.commands[0]
      if (command === undefined) {
        return preview?.kind === 'box' && preview.box.x === startX && preview.box.y === startY
      }
      return (
        command.kind === 'move-node' &&
        preview?.kind === 'box' &&
        preview.box.x === command.x &&
        preview.box.y === command.y
      )
    },
  )
})

describe('drag-preview / translation equivariance (fast-check)', () => {
  fcTest.prop([pointArb, pointArb], PROPERTY_PARAMS)(
    'moving: shifting the live point by (dx,dy) shifts the preview by exactly (dx,dy)',
    (livePoint, shift) => {
      const state: GestureState = {
        kind: 'moving',
        nodeId: 'n1',
        startType: 'text',
        startPoint: { x: 0, y: 0 },
        startX: 0,
        startY: 0,
      }
      const boxes: readonly NodeBox[] = [{ id: 'n1', box: { x: 0, y: 0, width: 10, height: 10 } }]
      const before = computeDragPreview(state, boxes, livePoint)
      const after = computeDragPreview(state, boxes, {
        x: livePoint.x + shift.x,
        y: livePoint.y + shift.y,
      })
      return (
        before?.kind === 'box' &&
        after?.kind === 'box' &&
        after.box.x - before.box.x === shift.x &&
        after.box.y - before.box.y === shift.y
      )
    },
  )

  fcTest.prop([boxArb, pointArb], PROPERTY_PARAMS)(
    'connecting over empty space: the routed preview ends AT the pointer and departs ON the source border',
    (fromBox, livePoint) => {
      const state: GestureState = { kind: 'connecting', fromNodeId: 'n1' }
      const boxes: readonly NodeBox[] = [{ id: 'n1', box: fromBox }]
      const canvas: SpatialCanvas = {
        nodes: [{ id: 'n1', type: 'text', ...fromBox, text: '' }],
        edges: [],
      }
      const preview = computeDragPreview(state, boxes, livePoint, {
        canvas,
        selectableBoxes: boxes,
      })
      if (preview?.kind !== 'line') return false
      const first = preview.path[0]
      const last = preview.path[preview.path.length - 1]
      if (first === undefined || last === undefined) return false
      // A pointer inside the source box hit-tests as the source itself,
      // which previews like empty space; either way the path must END at
      // the pointer (the phantom target's every anchor IS the pointer).
      const endsAtPointer = last.x === livePoint.x && last.y === livePoint.y
      // The departure sits on the source's border, never its interior.
      const onBorder =
        first.x === fromBox.x ||
        first.x === fromBox.x + fromBox.width ||
        first.y === fromBox.y ||
        first.y === fromBox.y + fromBox.height
      return endsAtPointer && onBorder
    },
  )

  // Resizing equivariance holds only where `resizeBoxByDelta` does not clamp
  // (an overshoot floors width/height at 0, which breaks linearity by
  // design — see geometry.ts). A box far larger than the shift range keeps
  // every delta below its clamp threshold, so this isolates the intended
  // linear-tracking property from that documented, unrelated clamp behavior.
  fcTest.prop(
    [fc.record({ x: smallInt, y: smallInt, width: largeSize, height: largeSize }), pointArb],
    PROPERTY_PARAMS,
  )(
    'resizing (unclamped range): shifting the live point shifts the preview by exactly the shift',
    (startBox, shift) => {
      const state: GestureState = {
        kind: 'resizing',
        nodeId: 'n1',
        startType: 'text',
        handle: 'se',
        startPoint: { x: 0, y: 0 },
        startBox,
      }
      const livePoint = { x: 0, y: 0 }
      const before = computeDragPreview(state, [], livePoint)
      const after = computeDragPreview(state, [], { x: shift.x, y: shift.y })
      return (
        before?.kind === 'box' &&
        after?.kind === 'box' &&
        after.box.width - before.box.width === shift.x &&
        after.box.height - before.box.height === shift.y
      )
    },
  )
})
