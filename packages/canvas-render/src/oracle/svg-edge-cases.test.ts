import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  decodeLines,
  encodeLines,
  type SvgRecord,
  svgAnswer,
} from '../test-utils/render-oracle/oracle.js'
import { svgEdgeCaseInputs } from '../test-utils/render-oracle/svg-edge-cases.js'

/**
 * The second recorded oracle of the SVG backend: small scenes aimed at one
 * rule each (an unusable option, a link's address, a degenerate box), which
 * the goldens and laid-out canvases reach only by accident. The Rust backend
 * replays it beside `svg.jsonl` (`tests/svg_edge_cases.rs`) and is held to it
 * byte for byte. Re-record after a deliberate backend change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node svg-edge-cases`.
 */
const FILE = new URL('./svg-edge-cases.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeLines(svgEdgeCaseInputs().map(svgAnswer)))
}

describe('the recorded SVG backend edge cases', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = decodeLines<SvgRecord>(text)

  it('reaches every group of cases', () => {
    const under = (prefix: string) => recorded.filter((r) => r.id.startsWith(prefix)).length
    for (const [prefix, floor] of [
      ['doc/', 15],
      ['legend/', 6],
      ['run/', 8],
      ['block/', 8],
      ['shape/', 5],
      ['edge/', 8],
      ['budget/', 9],
    ] as const) {
      expect(under(prefix), `cases under ${prefix}`).toBeGreaterThanOrEqual(floor)
    }
  })

  it('draws the over-budget boards with some of their filters dropped and the rest kept', () => {
    const filters = (id: string) => {
      const record = recorded.find((r) => r.id === id)
      return record === undefined ? -1 : record.svg.split('filter="url(#').length - 1
    }
    for (const [id, drawn] of [
      ['budget/neon-board', 80],
      ['budget/neon-board-2x', 25],
      ['budget/shadows', 80],
      ['budget/long-glow-edges', 40],
      ['budget/mixed', 70],
      ['budget/legend-room', 26],
      ['budget/odd-scales', 70],
      ['budget/negative-scale', 70],
    ] as const) {
      expect(filters(id), `${id} filters kept`).toBeLessThan(drawn)
    }
    expect(filters('budget/neon-board'), 'some kept').toBeGreaterThan(0)
    expect(filters('budget/neon-board-1x'), 'a board under the budget keeps all').toBe(25)
  })

  it('equals what the TypeScript answers today', () => {
    const lines = text.trimEnd().split('\n')
    const parted = recorded.findIndex(
      (r, i) =>
        JSON.stringify(svgAnswer({ id: r.id, scene: r.scene, options: r.options })) !== lines[i],
    )
    expect(
      recorded[parted]?.id,
      'the first recorded scene the TypeScript no longer draws as recorded',
    ).toBeUndefined()
  })
})
