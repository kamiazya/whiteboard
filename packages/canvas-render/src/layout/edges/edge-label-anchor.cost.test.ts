// What placing edge labels costs as a board grows. Every labelled edge and
// line asks `edgeLabelPlacement` for a spot, up to 33 candidate spots per
// label, and a candidate is clear only if it misses every obstacle on the
// board — so a board whose candidates keep colliding pays labels ×
// candidates × nodes on every render.
//
// Work, not wall time: obstacles are handed in as objects whose fields count
// their own reads, so every comparison against one is counted exactly and
// independently of machine load.

import type { CanvasLine, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { node } from '../../test-utils/spatial-node.js'
import { layoutSpatialCanvas } from '../spatial-canvas.js'
import { edgeLabelPlacement, type LabelObstacle } from './edge-label-anchor.js'

const reads = vi.hoisted(() => ({ count: 0 }))

/** An obstacle whose every field read is counted. */
function counted(box: LabelObstacle): LabelObstacle {
  return {
    get x() {
      reads.count++
      return box.x
    },
    get y() {
      reads.count++
      return box.y
    },
    get w() {
      reads.count++
      return box.w
    },
    get h() {
      reads.count++
      return box.h
    },
  }
}

vi.mock('./edge-label-anchor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./edge-label-anchor.js')>()
  return {
    ...actual,
    labelObstacles: (nodes: readonly SpatialNode[]) => actual.labelObstacles(nodes).map(counted),
  }
})

const GRID = 20
const CELL_PX = 400

/**
 * `n - 1` small boxes over a grid, then one board-sized box LAST: every
 * candidate spot of every label collides, and only after the whole list.
 */
function board(n: number): LabelObstacle[] {
  const boxes = Array.from({ length: n - 1 }, (_, i) => ({
    x: (i % GRID) * CELL_PX,
    y: Math.floor(i / GRID) * CELL_PX,
    w: 40,
    h: 40,
  }))
  const side = GRID * CELL_PX + 2000
  return [...boxes, { x: -1000, y: -1000, w: side, h: side }]
}

describe('edgeLabelPlacement cost', () => {
  it('reads a bounded number of fields per obstacle for a label nothing clears', () => {
    const n = 2000
    const obstacles = board(n).map(counted)
    const path = [
      { x: 200, y: 200 },
      { x: 300, y: 200 },
    ]
    reads.count = 0
    const at = edgeLabelPlacement(path, { w: 60, h: 16 }, obstacles)

    // The subject is present: nothing is clear, so the label stays at the
    // midpoint, and every obstacle was looked at.
    expect(at).toEqual({ x: 250, y: 200 })
    expect(reads.count).toBeGreaterThanOrEqual(n)
    // Was 196_614 reads, about 98 per obstacle, while every one of 33
    // candidates scanned the whole board. Now one pass over the board, then
    // only what lies within the search's reach.
    expect(reads.count / n).toBeLessThanOrEqual(6)
  })

  it('reads a bounded number of fields per label and obstacle over a whole layout', () => {
    const n = 400
    const labels = 400
    const nodes: SpatialNode[] = board(n).map((b, i) => node(`n${i}`, b.x, b.y, b.w, b.h))
    const lines: CanvasLine[] = Array.from({ length: labels }, (_, i) => {
      const x = (i % GRID) * CELL_PX + 100
      const y = Math.floor(i / GRID) * CELL_PX + 200
      return {
        id: `l${i}`,
        from: { kind: 'point', point: { x, y } },
        to: { kind: 'point', point: { x: x + 150, y } },
        label: 'label',
      }
    })
    const canvas: SpatialCanvas = { nodes, edges: [], lines }
    reads.count = 0
    const scene = layoutSpatialCanvas(canvas, {
      measure: createFakeMeasure(),
      parseBody: () => ({ type: 'root', children: [] }),
      appearance: {
        resolveNode: () => ({}),
        resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
        resolveLabel: () => ({ fill: '#303030' }),
      },
      geometry: { paddingPx: 8, labelFontSizePx: 14, minContentWidthPx: 1 },
    })

    // The subject is present: every line's label is placed, through the
    // counted obstacles.
    const placed = scene.nodes.filter((s) => s.kind === 'textRun' && s.text === 'label')
    expect(placed).toHaveLength(labels)
    expect(reads.count).toBeGreaterThanOrEqual(labels * n)
    // Was labels × candidates × nodes: 13_108_260 reads, about 82 per label
    // and obstacle.
    expect(reads.count / (labels * n)).toBeLessThanOrEqual(6)
  })
})
