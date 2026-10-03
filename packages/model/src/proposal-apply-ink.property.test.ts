/**
 * Adopting an addition or a removal and then asking whether it still fits.
 *
 * Applying a change and judging a change are two functions that must agree on
 * what "this element is on the board" means: an addition once adopted is a
 * collision if offered again, a removal once adopted has no anchor left, and
 * a removal whose prior is exactly what the board holds fits before it is
 * adopted. A property because the agreement has to hold for every id the
 * board can carry, on both element kinds that have collections of their own.
 */
import { describe, expect } from 'vitest'
import type { SpatialProposedChange } from './proposal.js'
import { applyCanvasChange, canvasChangeConflicts } from './proposal-apply.js'
import type { CanvasEdge, CanvasLine, SpatialCanvas } from './spatial.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const id = fc.stringMatching(/^[a-f]{1,3}$/)
const ids = fc.uniqueArray(id, { minLength: 1, maxLength: 5 })

const link = (edgeId: string): CanvasEdge => ({
  id: edgeId,
  from: { node: 'a' },
  to: { node: 'b' },
})
const ink = (lineId: string): CanvasLine => ({
  id: lineId,
  from: { kind: 'point', point: { x: 0, y: 0 } },
  to: { kind: 'point', point: { x: 1, y: 1 } },
})

const boardOf = (edgeIds: readonly string[], lineIds: readonly string[]): SpatialCanvas => ({
  nodes: [],
  edges: edgeIds.map(link),
  ...(lineIds.length > 0 && { lines: lineIds.map(ink) }),
})

const adds = (edgeId: string, lineId: string): SpatialProposedChange[] => [
  { id: 'x', status: 'open', op: 'edge.add', edge: link(edgeId) },
  { id: 'y', status: 'open', op: 'line.add', line: ink(lineId) },
]

const removals = (edgeId: string, lineId: string): SpatialProposedChange[] => [
  { id: 'x', status: 'open', op: 'edge.remove', edgeId, assumed: link(edgeId) },
  { id: 'y', status: 'open', op: 'line.remove', lineId, assumed: ink(lineId) },
]

describe('adopting a change and judging it again', () => {
  fcTest.prop([ids, ids, id, id], withDefaults())(
    'an addition fits a board without its id and collides once adopted',
    (edgeIds, lineIds, newEdge, newLine) => {
      const board = boardOf(
        edgeIds.filter((e) => e !== newEdge),
        lineIds.filter((l) => l !== newLine),
      )
      for (const change of adds(newEdge, newLine)) {
        expect(canvasChangeConflicts(change, board)).toBe(false)
        const adopted = applyCanvasChange(board, change)
        expect(canvasChangeConflicts(change, adopted)).toBe(true)
        expect(applyCanvasChange(adopted, change)).toEqual(adopted)
      }
    },
  )

  fcTest.prop([ids, ids], withDefaults())(
    'a removal fits the board it was read from and has no anchor once adopted',
    (edgeIds, lineIds) => {
      const board = boardOf(edgeIds, lineIds)
      for (const change of removals(edgeIds[0] as string, lineIds[0] as string)) {
        expect(canvasChangeConflicts(change, board)).toBe(false)
        const adopted = applyCanvasChange(board, change)
        expect(canvasChangeConflicts(change, adopted)).toBe(true)
      }
    },
  )
})
