// The editor draws the document's theme unless this tab overrides it
// (ADR-0030 decision 6): `style` is view state a host holds for the
// session, never written to the canvas.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

function fakeMeasure(text: string) {
  return { advanceWidth: text.length * 6, ascent: 10, descent: 2, lineGap: 0 }
}

const neon: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'a' },
    { id: 'b', type: 'text', x: 300, y: 200, width: 120, height: 60, text: 'b' },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  'x-whiteboard': { facets: { 'visual.theme/v0': { theme: 'visual.neon' } } },
}

const content = (root: HTMLElement) =>
  root.querySelector('[data-testid="canvas-content"]')?.innerHTML ?? ''

describe('SpatialEditor style', () => {
  it("draws the document's theme when the host holds no override", () => {
    const { container } = render(
      <SpatialEditor canvas={neon} onChange={vi.fn()} measure={fakeMeasure} />,
    )
    expect(content(container)).toContain('wb-glow')
  })

  it("style: 'clean' draws the bundled look, and a theme id previews that theme", () => {
    const clean = render(
      <SpatialEditor canvas={neon} onChange={vi.fn()} measure={fakeMeasure} style="clean" />,
    )
    expect(content(clean.container)).not.toContain('wb-glow')
    cleanup()
    const sketch = render(
      <SpatialEditor
        canvas={neon}
        onChange={vi.fn()}
        measure={fakeMeasure}
        style="visual.sketch"
      />,
    )
    expect(content(sketch.container)).toContain('stroke-linecap="round"')
    expect(content(sketch.container)).not.toContain('wb-glow')
  })
})
