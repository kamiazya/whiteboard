// Grid layout helper for annotate_batch.
// This avoids hand-writing coordinates for comparison or matrix-style diagrams.
// The contract returns each cell's top-left; centering within the cell is
// handled separately via text.align + width.

export interface GridLayout {
  cols: number
  rows: number
  cellW?: number
  cellH?: number
  colWidths?: number[]
  rowHeights?: number[]
  gap: number
  origin: { x: number; y: number }
}

export interface LayoutItem {
  row?: number
  col?: number
  rowSpan?: number
  colSpan?: number
  target?: { x: number; y: number }
}

export interface GridPlacement {
  x: number
  y: number
  width: number
  height: number
  row: number
  col: number
  rowSpan: number
  colSpan: number
  warnings: string[]
}

function resolveTrackSizes(
  count: number,
  explicit: number[] | undefined,
  fallback: number | undefined,
  name: 'colWidths' | 'rowHeights',
): number[] {
  if (explicit !== undefined) {
    if (explicit.length !== count) {
      throw new Error(`${name} length must equal ${count}`)
    }
    return explicit
  }
  if (fallback === undefined) {
    throw new Error(`${name} or fallback cell size is required`)
  }
  return Array.from({ length: count }, () => fallback)
}

function sumTracks(sizes: number[], start: number, span: number, gap: number): number {
  if (span <= 0) return 0
  let total = 0
  for (let i = 0; i < span; i++) {
    total += sizes[start + i] ?? 0
  }
  return total + Math.max(0, span - 1) * gap
}

function offsetForIndex(origin: number, sizes: number[], index: number, gap: number): number {
  let value = origin
  for (let i = 0; i < index; i++) {
    value += sizes[i] + gap
  }
  return value
}

export function resolveLayout(
  layout: GridLayout | undefined,
  item: LayoutItem,
): { x: number; y: number } {
  const hasRowCol = item.row !== undefined || item.col !== undefined
  const hasTarget = item.target !== undefined

  if (!hasRowCol) {
    if (hasTarget) {
      return { x: item.target!.x, y: item.target!.y }
    }
    throw new Error('item must specify either target or row/col')
  }

  if (item.row === undefined || item.col === undefined) {
    throw new Error('item must specify both row and col (or neither)')
  }

  if (!layout) {
    throw new Error('layout is required when item uses row/col')
  }

  if (item.row < 0 || item.row >= layout.rows) {
    throw new Error(`row ${item.row} out of range [0, ${layout.rows})`)
  }
  if (item.col < 0 || item.col >= layout.cols) {
    throw new Error(`col ${item.col} out of range [0, ${layout.cols})`)
  }

  const colWidths = resolveTrackSizes(layout.cols, layout.colWidths, layout.cellW, 'colWidths')
  const rowHeights = resolveTrackSizes(layout.rows, layout.rowHeights, layout.cellH, 'rowHeights')
  return {
    x: offsetForIndex(layout.origin.x, colWidths, item.col, layout.gap),
    y: offsetForIndex(layout.origin.y, rowHeights, item.row, layout.gap),
  }
}

export function resolveGridPlacement(
  layout: GridLayout,
  item: LayoutItem,
): GridPlacement {
  if (item.row === undefined || item.col === undefined) {
    throw new Error('item must specify both row and col')
  }
  const colWidths = resolveTrackSizes(layout.cols, layout.colWidths, layout.cellW, 'colWidths')
  const rowHeights = resolveTrackSizes(layout.rows, layout.rowHeights, layout.cellH, 'rowHeights')

  const warnings: string[] = []
  const rawRow = item.row
  const rawCol = item.col
  const row = Math.min(Math.max(rawRow, 0), Math.max(0, layout.rows - 1))
  const col = Math.min(Math.max(rawCol, 0), Math.max(0, layout.cols - 1))
  if (row !== rawRow || col !== rawCol) {
    warnings.push('grid position was clipped to layout bounds')
  }

  const requestedRowSpan = Math.max(1, Math.floor(item.rowSpan ?? 1))
  const requestedColSpan = Math.max(1, Math.floor(item.colSpan ?? 1))
  const rowSpan = Math.max(1, Math.min(requestedRowSpan, layout.rows - row))
  const colSpan = Math.max(1, Math.min(requestedColSpan, layout.cols - col))
  if (rowSpan !== requestedRowSpan || colSpan !== requestedColSpan) {
    warnings.push('grid span was clipped to layout bounds')
  }

  return {
    x: offsetForIndex(layout.origin.x, colWidths, col, layout.gap),
    y: offsetForIndex(layout.origin.y, rowHeights, row, layout.gap),
    width: sumTracks(colWidths, col, colSpan, layout.gap),
    height: sumTracks(rowHeights, row, rowSpan, layout.gap),
    row,
    col,
    rowSpan,
    colSpan,
    warnings,
  }
}
