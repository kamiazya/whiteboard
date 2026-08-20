// The redesign's one rule, made executable: a markdown body may sit on a
// SURFACE, and may never draw a BOX. Hierarchy comes from type, weight and
// space (apps/web/DESIGN.md), and every line this deletes was a line drawn
// around or under content to say "this is a region" — which at node scale,
// inside a box that already has its own stroke and radius, is a second box
// system inside the first.
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const options = { measure: createFakeMeasure(), maxWidth: 320, fontFamily: 'sans-serif' }
const layout = (children: MdastRoot['children']) =>
  layoutMdastBlocks({ type: 'root', children }, options)

const table: MdastRoot['children'][number] = {
  type: 'table',
  align: [],
  children: [1, 2, 3].map((n) => ({
    type: 'tableRow' as const,
    children: [
      { type: 'tableCell' as const, children: [{ type: 'text' as const, value: `k${n}` }] },
      { type: 'tableCell' as const, children: [{ type: 'text' as const, value: `v${n}` }] },
    ],
  })),
}

describe('a heading is ranked by type, not by a rule under it', () => {
  it('draws no rule at any level', () => {
    const scene = layout(
      [1, 2, 3, 4, 5, 6].map((depth) => ({
        type: 'heading' as const,
        depth: depth as 1 | 2 | 3 | 4 | 5 | 6,
        children: [{ type: 'text' as const, value: `h${depth}` }],
      })),
    )
    for (const node of scene.nodes) {
      expect(node.kind === 'heading' && 'rule' in node).toBe(false)
    }
  })

  it('never sets a heading below body size — h5 and h6 read as headings, not as fine print', () => {
    const scene = layout(
      [4, 5, 6].map((depth) => ({
        type: 'heading' as const,
        depth: depth as 4 | 5 | 6,
        children: [{ type: 'text' as const, value: 'h' }],
      })),
    )
    const sizes = scene.nodes.flatMap((node) =>
      node.kind === 'heading' ? node.runs.map((run) => run.appearance?.fontSize ?? 16) : [],
    )
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16)
  })
})

describe('a table is separated by rows, not drawn as a grid', () => {
  it('gives no cell a border of its own', () => {
    const laid = layout([table]).nodes.find((node) => node.kind === 'table')
    if (laid?.kind !== 'table') throw new Error('expected a table')
    for (const row of laid.rows) {
      for (const cell of row.cells) expect(cell.appearance).toBeUndefined()
    }
  })

  it('separates every row but the last, and washes none of them', () => {
    const laid = layout([table]).nodes.find((node) => node.kind === 'table')
    if (laid?.kind !== 'table') throw new Error('expected a table')
    const separated = laid.rows.map((row) => row.appearance !== undefined)
    expect(separated).toEqual([true, true, false])
  })

  it('still bolds the header, which is hierarchy rather than chrome', () => {
    const laid = layout([table]).nodes.find((node) => node.kind === 'table')
    if (laid?.kind !== 'table') throw new Error('expected a table')
    expect(laid.rows[0]?.header).toBe(true)
    expect(laid.rows[0]?.cells[0]?.runs[0]?.strong).toBe(true)
  })
})

describe('a thematic break is a hairline with air, not a slab', () => {
  it('is one border width tall', () => {
    const hr = layout([{ type: 'thematicBreak' }]).nodes.find(
      (node) => node.kind === 'thematicBreak',
    )
    expect(hr?.bbox.h).toBe(1)
  })
})
