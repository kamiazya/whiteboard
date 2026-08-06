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
    'connecting: shifting the live point shifts the line "to" endpoint, leaving "from" invariant',
    (fromBox, shift) => {
      const state: GestureState = { kind: 'connecting', fromNodeId: 'n1' }
      const boxes: readonly NodeBox[] = [{ id: 'n1', box: fromBox }]
      const livePoint = { x: 0, y: 0 }
      const before = computeDragPreview(state, boxes, livePoint)
      const after = computeDragPreview(state, boxes, {
        x: livePoint.x + shift.x,
        y: livePoint.y + shift.y,
      })
      return (
        before?.kind === 'line' &&
        after?.kind === 'line' &&
        after.from.x === before.from.x &&
        after.from.y === before.from.y &&
        after.to.x - before.to.x === shift.x &&
        after.to.y - before.to.y === shift.y
      )
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
