// The editor draws the document's OWN theme, and has no way to draw
// anything else. ADR-0030 decision 6's `style` argument still reaches every
// render entry point below this one — headless callers ask for `'clean'` —
// but no editor prop sets it any more, so the board a person edits and the
// board every other surface pictures cannot disagree.
import { resolveCanvasPalette, SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

function fakeMeasure(text: string) {
  return { advanceWidth: text.length * 6, ascent: 10, descent: 2, lineGap: 0 }
}

function themed(theme: string): SpatialCanvas {
  return {
    nodes: [
      { id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'a' },
      { id: 'b', type: 'text', x: 300, y: 200, width: 120, height: 60, text: 'b' },
    ],
    edges: [
      {
        id: 'e',
        from: { node: 'a' },
        to: { node: 'b' },
      },
    ],
    facets: { 'visual.theme/v0': { theme } },
  }
}

const content = (root: HTMLElement) =>
  root.querySelector('[data-testid="canvas-content"]')?.innerHTML ?? ''

/**
 * The ink every canvas-space layer inherits — markdown body runs carry no
 * `fill` of their own, and the in-place drafts are typed in the same value.
 */
const inheritedFill = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-testid="viewport-transform"]')?.style.fill ?? ''

/** jsdom normalizes an inline `#RRGGBB` colour to `rgb(r, g, b)`. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`
}

describe('SpatialEditor theme', () => {
  it('draws the theme the canvas names', () => {
    const { container } = render(
      <SpatialEditor canvas={themed('visual.neon')} onChange={vi.fn()} measure={fakeMeasure} />,
    )
    expect(content(container)).toContain('wb-glow')
  })

  // Two themes rather than one: a single case passes just as well against an
  // editor that hardcodes the look it happens to be asked for.
  it('reads the theme from the canvas rather than drawing one look for every board', () => {
    const { container } = render(
      <SpatialEditor canvas={themed('visual.sketch')} onChange={vi.fn()} measure={fakeMeasure} />,
    )
    expect(content(container)).toContain('stroke-linecap="round"')
    expect(content(container)).not.toContain('wb-glow')
  })

  it("inks what is typed over the board in the theme's own label fill", () => {
    const neon = themed('visual.neon')
    const palette = resolveCanvasPalette(neon, 'light')
    // Non-vacuous: neon's label fill is not the bundled one, so a chrome
    // reading the bundled palette is visible here.
    expect(palette.labelFill).not.toBe(SPATIAL_LIGHT_PALETTE.labelFill)
    const board = render(<SpatialEditor canvas={neon} onChange={vi.fn()} measure={fakeMeasure} />)
    expect(inheritedFill(board.container)).toBe(rgb(palette.labelFill))
    cleanup()
    const plain = render(
      <SpatialEditor canvas={{ nodes: [], edges: [] }} onChange={vi.fn()} measure={fakeMeasure} />,
    )
    expect(inheritedFill(plain.container)).toBe(rgb(SPATIAL_LIGHT_PALETTE.labelFill))
  })
})
