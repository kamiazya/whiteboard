import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sceneBounds } from '../scene-bounds.js'
import { decodeLines, type SvgRecord } from '../test-utils/render-oracle/oracle.js'

/**
 * The second recorded oracle of the SVG backend: small scenes aimed at one
 * rule each (an unusable option, a link's address, a degenerate box), which
 * the goldens and laid-out canvases reach only by accident. The Rust backend
 * replays it beside `svg.jsonl` (`tests/svg_edge_cases.rs`) and is held to it
 * byte for byte. It is frozen with `svg.jsonl` (ADR-0054 A3.6): the case list
 * that built it went with the TypeScript backend, and nothing re-records it.
 */
const FILE = new URL('./svg-edge-cases.jsonl', import.meta.url)

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

  it('draws a haloed run inside the scene bounds that count its pill', () => {
    const record = recorded.find((r) => r.id === 'run/halo')
    const pill =
      /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*fill="#ffffff"/.exec(
        record?.svg ?? '',
      )
    expect(pill).not.toBeNull()
    const [x, y, w, h] = (pill ?? []).slice(1).map(Number) as [number, number, number, number]
    const bounds = sceneBounds(record?.scene ?? { nodes: [] })
    // The pill sets the left and top edge: the run's own box starts 2px inside it.
    expect(bounds.x).toBe(x)
    expect(bounds.y).toBe(y)
    expect(bounds.x + bounds.w).toBeGreaterThanOrEqual(x + w)
    expect(bounds.y + bounds.h).toBeGreaterThanOrEqual(y + h)
  })
})
