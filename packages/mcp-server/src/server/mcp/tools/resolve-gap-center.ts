import type { GridLayout } from './resolve-layout.js'

// Return the center point of the gap between two adjacent grid cells.
// This is used by annotate_batch to place arrow waypoints or boundary labels
// declaratively between horizontally or vertically adjacent cells.
// Rules:
// - same row and |col diff| = 1 -> horizontal gap center
// - same col and |row diff| = 1 -> vertical gap center
// - same cell / non-adjacent / diagonal -> error
export interface GridCell {
  row: number
  col: number
}

export function resolveGapCenter(
  layout: GridLayout,
  a: GridCell,
  b: GridCell,
): { x: number; y: number } {
  assertInRange(layout, a)
  assertInRange(layout, b)

  const sameRow = a.row === b.row
  const sameCol = a.col === b.col
  const colDiff = Math.abs(a.col - b.col)
  const rowDiff = Math.abs(a.row - b.row)

  if (sameRow && colDiff === 1) {
    // Horizontal adjacency: right edge of the left cell + gap/2.
    const leftCol = Math.min(a.col, b.col)
    const widths = resolveColWidths(layout)
    const x = trackStart(layout.origin.x, widths, leftCol, layout.gap) + widths[leftCol] + layout.gap / 2
    const y = cellCenterY(layout, a.row)
    return { x, y }
  }

  if (sameCol && rowDiff === 1) {
    // Vertical adjacency: bottom edge of the top cell + gap/2.
    const topRow = Math.min(a.row, b.row)
    const heights = resolveRowHeights(layout)
    const y = trackStart(layout.origin.y, heights, topRow, layout.gap) + heights[topRow] + layout.gap / 2
    const x = cellCenterX(layout, a.col)
    return { x, y }
  }

  throw new Error(
    `cells must be horizontally or vertically adjacent (got a=(${a.row},${a.col}) b=(${b.row},${b.col}))`,
  )
}

function assertInRange(layout: GridLayout, cell: GridCell): void {
  if (cell.row < 0 || cell.row >= layout.rows) {
    throw new Error(`row ${cell.row} out of range [0, ${layout.rows})`)
  }
  if (cell.col < 0 || cell.col >= layout.cols) {
    throw new Error(`col ${cell.col} out of range [0, ${layout.cols})`)
  }
}

function resolveColWidths(layout: GridLayout): number[] {
  if (layout.colWidths !== undefined) {
    if (layout.colWidths.length !== layout.cols) {
      throw new Error(`colWidths length must equal ${layout.cols}`)
    }
    return layout.colWidths
  }
  if (layout.cellW === undefined) {
    throw new Error('colWidths or cellW is required')
  }
  const cellW = layout.cellW
  return Array.from({ length: layout.cols }, () => cellW)
}

function resolveRowHeights(layout: GridLayout): number[] {
  if (layout.rowHeights !== undefined) {
    if (layout.rowHeights.length !== layout.rows) {
      throw new Error(`rowHeights length must equal ${layout.rows}`)
    }
    return layout.rowHeights
  }
  if (layout.cellH === undefined) {
    throw new Error('rowHeights or cellH is required')
  }
  const cellH = layout.cellH
  return Array.from({ length: layout.rows }, () => cellH)
}

function trackStart(origin: number, sizes: number[], index: number, gap: number): number {
  let value = origin
  for (let i = 0; i < index; i++) {
    value += sizes[i] + gap
  }
  return value
}

function cellCenterX(layout: GridLayout, col: number): number {
  const widths = resolveColWidths(layout)
  return trackStart(layout.origin.x, widths, col, layout.gap) + widths[col] / 2
}

function cellCenterY(layout: GridLayout, row: number): number {
  const heights = resolveRowHeights(layout)
  return trackStart(layout.origin.y, heights, row, layout.gap) + heights[row] / 2
}
