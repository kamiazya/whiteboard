import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { MARKDOWN_THEME_NODE } from '../../theme/markdown-theme.js'
import { typesetMdastBlocks } from './mdast-blocks.js'

const options = { measure: createFakeMeasure(), fontFamily: 'sans-serif' }
/** The narrowest a column is scaled to: its padding plus one em. */
const COLUMN_FLOOR =
  2 * MARKDOWN_THEME_NODE.tableCellPaddingXPx + MARKDOWN_THEME_NODE.bodyFontSizePx

describe('typesetMdastBlocks — a table wider than its node is scaled to fit', () => {
  const cell = (value: string) => ({
    type: 'tableCell' as const,
    children: [{ type: 'text' as const, value }],
  })
  const tableOf = (rows: readonly (readonly string[])[]): MdastRoot => ({
    type: 'root',
    children: [
      {
        type: 'table',
        align: [],
        children: rows.map((cells) => ({ type: 'tableRow' as const, children: cells.map(cell) })),
      },
    ],
  })
  const tableIn = (root: MdastRoot, maxWidth: number) => {
    const table = typesetMdastBlocks(root, { ...options, maxWidth }).nodes.find(
      (node) => node.kind === 'table',
    )
    if (table?.kind !== 'table') throw new Error('expected a table')
    return table
  }
  const wide = tableOf([
    ['first heading here', 'second heading here', 'third heading here'],
    ['alpha beta gamma delta', 'epsilon zeta eta theta', 'iota kappa lambda mu'],
  ])

  it('fills maxWidth and keeps every cell inside it', () => {
    const table = tableIn(wide, 240)
    expect(table.bbox.w).toBeLessThanOrEqual(240.001)
    // Scaled, not collapsed: the columns still fill the width they were given.
    expect(table.bbox.w).toBeGreaterThan(216)
    for (const row of table.rows) {
      for (const c of row.cells) {
        expect(c.bbox.w).toBeGreaterThan(0)
        expect(c.bbox.x + c.bbox.w).toBeLessThanOrEqual(table.bbox.x + 240.001)
      }
    }
  })

  it('keeps its natural, content-sized columns when it fits', () => {
    expect(tableIn(wide, 5000).bbox.w).toBeGreaterThan(tableIn(wide, 240).bbox.w)
  })

  // A one-character column scales below the floor that keeps a column wider
  // than its own padding; the width that floor adds has to come out of the
  // other columns, or the table paints past its node by exactly that much.
  it('takes a floored column’s width out of the others', () => {
    const table = tableIn(tableOf([['a', 'alpha beta gamma delta epsilon']]), 240)
    expect(table.bbox.w).toBeLessThanOrEqual(240.001)
    expect(table.bbox.w).toBeGreaterThan(239)
    const [narrow, rest] = table.rows[0]?.cells ?? []
    expect(narrow?.bbox.w).toBe(COLUMN_FLOOR)
    expect(rest?.bbox.w).toBeCloseTo(240 - COLUMN_FLOOR, 6)
  })
})
