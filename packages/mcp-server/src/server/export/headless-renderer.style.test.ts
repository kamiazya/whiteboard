// The export honours a document's theme only when asked (ADR-0030 decision
// 6), and declares a theme's font family only where it can MEASURE it — the
// vendored faces, or a face the user installed — so the family in the SVG is
// always the family the coordinates came from. Nothing is installed in this
// file; the installed half is `headless-renderer.installed-face.test.ts`.
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { renderSpatialCanvasToSvg } from './headless-renderer.js'

const themed = (theme: string): SpatialCanvas => ({
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 160, height: 60, text: 'a' },
    { id: 'b', type: 'text', x: 300, y: 200, width: 160, height: 60, text: 'b' },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  'x-whiteboard': { facets: { 'visual.theme/v0': { theme } } },
})

describe('export style', () => {
  it('defaults to clean, so the document theme never changes exported bytes unasked', async () => {
    const plain = await renderSpatialCanvasToSvg(themed('visual.neon'))
    expect(plain.svg).not.toContain('wb-glow')
  })

  it("style: 'document' draws the neon halo, in the dark palette when theme is dark", async () => {
    const dark = await renderSpatialCanvasToSvg(themed('visual.neon'), {
      style: 'document',
      theme: 'dark',
    })
    expect(dark.svg).toContain('filterUnits="userSpaceOnUse"')
    expect(dark.svg).toContain('#a5b4c7')
  })

  it('a sketch export declares the bundled family, not the handwriting one it cannot measure', async () => {
    const sketch = await renderSpatialCanvasToSvg(themed('visual.sketch'), { style: 'document' })
    expect(sketch.svg).toContain('stroke-linecap="round"')
    expect(sketch.svg).not.toContain('Yomogi')
    expect(sketch.svg).toContain('font-family="Roboto"')
    expect(sketch.unresolvedFamilies).toEqual([])
  })
})

// The paper an export comes back on is the theme's, not the bundled one: a
// neon canvas exported as neon strokes on the bundled sheet is a picture
// nobody drawing on that board has ever seen. `resolveCanvasPalette` is the
// same answer the editor paints its own paper from, so the two cannot drift.
describe('export paper', () => {
  const backgroundRect = (svg: string): string => {
    const match = svg.match(/<rect[^>]*fill="([^"]+)"[^>]*role="presentation"/)
    if (!match) throw new Error('expected a background rect')
    return match[1]
  }

  const rootTextFill = (svg: string): string | undefined =>
    svg.slice(0, svg.indexOf('>')).match(/ fill="([^"]+)"/)?.[1]

  it("a themed export in dark mode comes back on the theme's dark surface", async () => {
    const neon = await renderSpatialCanvasToSvg(themed('visual.neon'), {
      style: 'document',
      theme: 'dark',
    })
    expect(backgroundRect(neon.svg)).toBe('#030711')
    // And the root's inheritable text fill — what a markdown body run with no
    // fill of its own inherits — is the theme's label colour, not the bundled
    // dark one, since dark node chrome is transparent and those runs sit
    // straight on that surface.
    expect(rootTextFill(neon.svg)).toBe('#f5fbff')
  })

  it("a themed export in light mode comes back on the theme's light surface", async () => {
    const sketch = await renderSpatialCanvasToSvg(themed('visual.sketch'), { style: 'document' })
    expect(backgroundRect(sketch.svg)).toBe('#fffdf7')
  })

  it('a clean export keeps the bundled surface, whatever theme the canvas names', async () => {
    const clean = await renderSpatialCanvasToSvg(themed('visual.neon'), { theme: 'dark' })
    expect(backgroundRect(clean.svg)).toBe(SPATIAL_DARK_PALETTE.surface)
    const light = await renderSpatialCanvasToSvg(themed('visual.neon'))
    expect(backgroundRect(light.svg)).toBe(SPATIAL_LIGHT_PALETTE.surface)
  })

  it('an explicit background still wins over the theme', async () => {
    const asked = await renderSpatialCanvasToSvg(themed('visual.neon'), {
      style: 'document',
      theme: 'dark',
      background: '#123456',
    })
    expect(backgroundRect(asked.svg)).toBe('#123456')
  })
})
