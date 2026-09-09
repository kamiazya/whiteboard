// The export honours a document's theme only when asked (ADR-0030 decision
// 6), and declares a theme's font family only where it can MEASURE it — the
// vendored faces — so the family in the SVG is always the family the
// coordinates came from.
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
