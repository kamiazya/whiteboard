import { describe, expect, it } from 'vitest'
import type { GridLayout } from './resolve-layout.js'
import { resolveGapCenter } from './resolve-gap-center.js'

// Helper for resolving the center of the gap between grid cells.
const layout: GridLayout = {
  cols: 3,
  rows: 2,
  cellW: 100,
  cellH: 80,
  gap: 20,
  origin: { x: 50, y: 30 },
}

describe('resolveGapCenter', () => {
  it('returns the gap center for horizontally adjacent cells (r=0,c=0) and (r=0,c=1)', () => {
    // c=0 right edge = origin.x + cellW = 50 + 100 = 150
    // gap center = 150 + gap/2 = 160
    // cell-center y = origin.y + cellH/2 = 30 + 40 = 70
    expect(resolveGapCenter(layout, { row: 0, col: 0 }, { row: 0, col: 1 })).toEqual({
      x: 160,
      y: 70,
    })
  })

  it('returns the same center for reversed horizontal adjacency order', () => {
    expect(resolveGapCenter(layout, { row: 0, col: 1 }, { row: 0, col: 0 })).toEqual({
      x: 160,
      y: 70,
    })
  })

  it('returns the gap center for horizontally adjacent cells (r=1,c=1) and (r=1,c=2)', () => {
    // c=1 right edge = 50 + 100 + 20 + 100 = 270
    // gap center = 270 + 10 = 280
    // r=1 cell-center y = 30 + (80 + 20) + 40 = 170
    expect(resolveGapCenter(layout, { row: 1, col: 1 }, { row: 1, col: 2 })).toEqual({
      x: 280,
      y: 170,
    })
  })

  it('returns the gap center for vertically adjacent cells (r=0,c=1) and (r=1,c=1)', () => {
    // r=0 bottom edge = origin.y + cellH = 30 + 80 = 110
    // gap center = 110 + 10 = 120
    // c=1 cell-center x = 50 + cellW + gap + cellW/2 = 220
    expect(resolveGapCenter(layout, { row: 0, col: 1 }, { row: 1, col: 1 })).toEqual({
      x: 220,
      y: 120,
    })
  })

  it('returns the same center for reversed vertical adjacency order', () => {
    expect(resolveGapCenter(layout, { row: 1, col: 1 }, { row: 0, col: 1 })).toEqual({
      x: 220,
      y: 120,
    })
  })

  it('returns gap centers with variable track sizes', () => {
    const variableLayout: GridLayout = {
      cols: 3,
      rows: 2,
      colWidths: [80, 140, 120],
      rowHeights: [60, 100],
      gap: 20,
      origin: { x: 50, y: 30 },
    }

    expect(resolveGapCenter(variableLayout, { row: 0, col: 0 }, { row: 0, col: 1 })).toEqual({
      x: 140,
      y: 60,
    })
    expect(resolveGapCenter(variableLayout, { row: 0, col: 1 }, { row: 1, col: 1 })).toEqual({
      x: 220,
      y: 100,
    })
  })

  it('throws for non-adjacent cells in the same row', () => {
    expect(() => resolveGapCenter(layout, { row: 0, col: 0 }, { row: 0, col: 2 })).toThrow(
      /adjacent/,
    )
  })

  it('throws for non-adjacent cells in the same column', () => {
    const tallLayout: GridLayout = { ...layout, rows: 3 }
    expect(() => resolveGapCenter(tallLayout, { row: 0, col: 0 }, { row: 2, col: 0 })).toThrow(
      /adjacent/,
    )
  })

  it('throws for diagonal cells', () => {
    expect(() => resolveGapCenter(layout, { row: 0, col: 0 }, { row: 1, col: 1 })).toThrow(
      /adjacent/,
    )
  })

  it('throws for the same cell', () => {
    expect(() => resolveGapCenter(layout, { row: 0, col: 0 }, { row: 0, col: 0 })).toThrow(
      /adjacent/,
    )
  })

  it('throws for an out-of-range row', () => {
    expect(() => resolveGapCenter(layout, { row: 0, col: 0 }, { row: 2, col: 0 })).toThrow(
      /out of range/,
    )
  })

  it('throws for an out-of-range col', () => {
    expect(() => resolveGapCenter(layout, { row: 0, col: 0 }, { row: 0, col: 3 })).toThrow(
      /out of range/,
    )
  })

  it('throws for negative row/col values', () => {
    expect(() => resolveGapCenter(layout, { row: -1, col: 0 }, { row: 0, col: 0 })).toThrow(
      /out of range/,
    )
  })
})
