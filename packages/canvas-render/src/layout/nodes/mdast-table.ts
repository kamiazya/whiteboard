// A GFM table: columns sized to content and scaled to fit, rows laid out
// cell by cell and zebra-striped from the header the way GitHub does.
import type { MdastCellPhrasingContent, MdastFlowContent } from '@kamiazya/whiteboard-model/mdast'
import type { TableCellSceneNode, TableRowSceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import {
  bodyLineHeightPx,
  type Cursor,
  measureRunWidth,
  type PhrasingLayout,
  panelPaint,
  type ResolvedMdastOptions,
} from './mdast-layout-options.js'

/**
 * The inline typesetter a cell's content goes through, handed in by the
 * block dispatcher: it lives beside the dispatcher, and a table that
 * imported it would close a cycle through the module that lays tables out.
 */
export type LayoutPhrasing = (
  children: readonly MdastCellPhrasingContent[],
  cursor: Cursor,
  options: ResolvedMdastOptions,
  fontSizePx: number,
  style?: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
) => PhrasingLayout

/**
 * Column widths sized to CONTENT, then scaled to fit. An equal split made a
 * two-word column as wide as a sentence, which is most of why the old table
 * read as floating text rather than as a table; GitHub sizes to content the
 * same way. Scaling down (rather than clipping) keeps the table inside the
 * column, and the floor stops a scaled column from collapsing under its own
 * padding.
 */
export function tableColumnWidths(
  node: Extract<MdastFlowContent, { type: 'table' }>,
  columnCount: number,
  options: ResolvedMdastOptions,
): number[] {
  const natural = Array.from({ length: columnCount }, () => 0)
  for (const row of node.children) {
    for (const [index, cell] of row.children.entries()) {
      const text = cellPlainText(cell.children)
      const ink = measureRunWidth(
        options.measure,
        options.fontFamily,
        text,
        options.theme.bodyFontSizePx,
        {
          strong: true,
        },
      )
      natural[index] = Math.max(natural[index] ?? 0, ink + 2 * options.theme.tableCellPaddingXPx)
    }
  }
  const total = natural.reduce((sum, w) => sum + w, 0)
  if (!Number.isFinite(options.maxWidth) || options.maxWidth <= 0 || total <= options.maxWidth) {
    return natural
  }
  const minimum = 2 * options.theme.tableCellPaddingXPx + options.theme.bodyFontSizePx
  const scale = options.maxWidth / total
  return natural.map((w) => Math.max(w * scale, minimum))
}

/** A cell's text with no styling, for width measurement only. */
export function cellPlainText(children: readonly MdastCellPhrasingContent[]): string {
  let text = ''
  for (const child of children) {
    if ('value' in child && typeof child.value === 'string') text += child.value
    else if ('children' in child && Array.isArray(child.children)) {
      text += cellPlainText(child.children as readonly MdastCellPhrasingContent[])
    }
  }
  return text
}

/**
 * A row's cells, laid out BEFORE the row has a height: a column narrow
 * enough to wrap its content is reachable (`tableColumnWidths` scales
 * columns down to fit), and a row fixed at one line box would paint the
 * overflow across the row below it.
 */
function layoutTableCells(
  cells: readonly { children: readonly MdastCellPhrasingContent[] }[],
  ctx: {
    cursor: Cursor
    options: ResolvedMdastOptions
    columnWidths: readonly number[]
    header: boolean
    layoutPhrasing: LayoutPhrasing
  },
): { cellX: number; width: number; runs: readonly TextRunNode[]; lineCount: number }[] {
  const { cursor, options, columnWidths, header, layoutPhrasing } = ctx
  let x = cursor.x
  return cells.map((cell, cellIndex) => {
    const width = columnWidths[cellIndex] ?? 0
    const cellX = x
    x += width
    const { runs, lineCount } = layoutPhrasing(
      cell.children,
      { y: cursor.y + options.theme.tableCellPaddingYPx, x: options.theme.tableCellPaddingXPx },
      { ...options, maxWidth: width - 2 * options.theme.tableCellPaddingXPx },
      options.theme.bodyFontSizePx,
      header ? { strong: true } : {},
    )
    return { cellX, width, runs, lineCount }
  })
}

/**
 * One table row, laid out cell by cell.
 *
 * The first mdast table row IS the header; GitHub bolds it and starts its
 * zebra on the row after, so the parity check counts from the header exactly
 * as `tr:nth-child(2n)` does.
 *
 * Cells are laid out BEFORE the row has a height: a column narrow enough to
 * wrap its content is reachable (`tableColumnWidths` scales columns down to
 * fit), and a row fixed at one line box would paint the overflow across the
 * row below it.
 */
export function layoutTableRow(
  row: { children: readonly { children: readonly MdastCellPhrasingContent[] }[] },
  rowIndex: number,
  rowCount: number,
  ctx: {
    cursor: Cursor
    options: ResolvedMdastOptions
    columnWidths: readonly number[]
    tableWidth: number
    layoutPhrasing: LayoutPhrasing
  },
): TableRowSceneNode {
  const { cursor, options, columnWidths, tableWidth, layoutPhrasing } = ctx
  const rowY = cursor.y
  // The first mdast table row IS the header; GitHub bolds it and
  // starts its zebra on the row after, so the parity check counts
  // from the header exactly as `tr:nth-child(2n)` does.
  const header = rowIndex === 0
  const last = rowIndex === rowCount - 1
  const laid = layoutTableCells(row.children, {
    cursor,
    options,
    columnWidths,
    header,
    layoutPhrasing,
  })
  const rowHeight =
    Math.max(...laid.map((cell) => cell.lineCount), 1) * bodyLineHeightPx(options.theme) +
    2 * options.theme.tableCellPaddingYPx
  const cells: TableCellSceneNode[] = laid.map((cell) => ({
    kind: 'tableCell',
    bbox: { x: cell.cellX, y: rowY, w: cell.width, h: rowHeight },
    runs: cell.runs,
  }))
  cursor.y += rowHeight
  return {
    kind: 'tableRow',
    bbox: { x: cursor.x, y: rowY, w: tableWidth, h: rowHeight },
    cells,
    ...(header ? { header: true } : {}),
    ...(last ? {} : { appearance: panelPaint(options.theme, options.theme.borderOpacity) }),
  }
}
