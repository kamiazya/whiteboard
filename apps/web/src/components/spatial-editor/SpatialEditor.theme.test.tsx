// The editor draws the document's OWN theme, and has no way to draw
// anything else. ADR-0030 decision 6's `style` argument still reaches every
// render entry point below this one — headless callers ask for `'clean'` —
// but no editor prop sets it any more, so the board a person edits and the
// board every other surface pictures cannot disagree.
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
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    'x-whiteboard': { facets: { 'visual.theme/v0': { theme } } },
  }
}

const content = (root: HTMLElement) =>
  root.querySelector('[data-testid="canvas-content"]')?.innerHTML ?? ''

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
})
