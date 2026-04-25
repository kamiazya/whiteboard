import { describe, expect, it } from 'vitest'
import { resolveGridPlacement, resolveLayout } from './resolve-layout.js'

const LAYOUT = {
  cols: 3,
  rows: 2,
  cellW: 100,
  cellH: 50,
  gap: 10,
  origin: { x: 0, y: 0 },
}

describe('resolveLayout', () => {
  it('returns origin for (row=0, col=0)', () => {
    expect(resolveLayout(LAYOUT, { row: 0, col: 0 })).toEqual({ x: 0, y: 0 })
  })

  it('increments x by cellW+gap as col advances', () => {
    expect(resolveLayout(LAYOUT, { row: 0, col: 2 })).toEqual({ x: 220, y: 0 })
  })

  it('increments y by cellH+gap as row advances', () => {
    expect(resolveLayout(LAYOUT, { row: 1, col: 0 })).toEqual({ x: 0, y: 60 })
  })

  it('adds the origin offset', () => {
    const l = { ...LAYOUT, origin: { x: 50, y: 100 } }
    expect(resolveLayout(l, { row: 1, col: 2 })).toEqual({ x: 270, y: 160 })
  })

  it('works when gap=0', () => {
    const l = { ...LAYOUT, gap: 0 }
    expect(resolveLayout(l, { row: 1, col: 1 })).toEqual({ x: 100, y: 50 })
  })

  it('returns target directly when target is specified', () => {
    expect(resolveLayout(LAYOUT, { target: { x: 777, y: 888 } })).toEqual({ x: 777, y: 888 })
  })

  it('works without layout if target is provided', () => {
    expect(resolveLayout(undefined, { target: { x: 10, y: 20 } })).toEqual({ x: 10, y: 20 })
  })

  it('throws when target and row/col are both specified', () => {
    expect(() =>
      resolveLayout(LAYOUT, { row: 0, col: 0, target: { x: 1, y: 2 } }),
    ).toThrow(/both target and row\/col/)
  })

  it('throws when only row is specified', () => {
    expect(() => resolveLayout(LAYOUT, { row: 0 })).toThrow(/both row and col/)
  })

  it('throws when only col is specified', () => {
    expect(() => resolveLayout(LAYOUT, { col: 0 })).toThrow(/both row and col/)
  })

  it('throws when row/col is used without layout', () => {
    expect(() => resolveLayout(undefined, { row: 0, col: 0 })).toThrow(/layout is required/)
  })

  it('throws when neither target nor row/col is provided', () => {
    expect(() => resolveLayout(LAYOUT, {})).toThrow(/target or row\/col/)
  })

  it('throws when row is out of range', () => {
    expect(() => resolveLayout(LAYOUT, { row: 2, col: 0 })).toThrow(/out of range/)
  })

  it('throws when col is out of range', () => {
    expect(() => resolveLayout(LAYOUT, { row: 0, col: 3 })).toThrow(/out of range/)
  })

  it('throws for negative row / col values', () => {
    expect(() => resolveLayout(LAYOUT, { row: -1, col: 0 })).toThrow(/out of range/)
    expect(() => resolveLayout(LAYOUT, { row: 0, col: -1 })).toThrow(/out of range/)
  })
})

describe('resolveGridPlacement', () => {
  it('computes cell positions with variable colWidths / rowHeights', () => {
    const placement = resolveGridPlacement(
      {
        cols: 4,
        rows: 3,
        colWidths: [200, 400, 500, 540],
        rowHeights: [80, 120, 160],
        gap: 20,
        origin: { x: 40, y: 100 },
      },
      { row: 1, col: 2 },
    )
    expect(placement).toMatchObject({
      x: 680,
      y: 200,
      width: 500,
      height: 120,
      warnings: [],
    })
  })

  it('returns width / height for the requested colSpan / rowSpan', () => {
    const placement = resolveGridPlacement(
      {
        cols: 3,
        rows: 4,
        colWidths: [180, 220, 260],
        rowHeights: [60, 70, 80, 90],
        gap: 10,
        origin: { x: 0, y: 0 },
      },
      { row: 1, col: 0, rowSpan: 2, colSpan: 2 },
    )
    expect(placement).toMatchObject({
      x: 0,
      y: 70,
      width: 410,
      height: 160,
      warnings: [],
    })
  })

  it('clips oversized spans to grid bounds and returns a warning', () => {
    const placement = resolveGridPlacement(
      {
        cols: 3,
        rows: 2,
        cellW: 100,
        cellH: 50,
        gap: 10,
        origin: { x: 0, y: 0 },
      },
      { row: 1, col: 2, rowSpan: 3, colSpan: 2 },
    )
    expect(placement).toMatchObject({
      x: 220,
      y: 60,
      width: 100,
      height: 50,
    })
    expect(placement.warnings).toEqual([
      expect.stringMatching(/clipped/i),
    ])
  })
})
