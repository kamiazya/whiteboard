// The injected SVG had no role and no name: to a screen reader the viewer was
// an unlabelled generic box whose only content was a stream of disconnected
// text runs. It needs a NAME without losing that content — `role="img"` would
// have supplied the name while marking every child presentational, trading the
// one access path there is for a label. `figure` names the region and keeps
// its children reachable, which is the honest interim until canvas-render
// grows the a11y projection its README defers.

import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'

const fakeMeasure: MeasureText = (text) => ({
  advanceWidth: text.length * 8,
  ascent: 12,
  descent: 4,
  lineGap: 0,
})

afterEach(cleanup)

const canvas: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'Hello' }],
  edges: [],
}

describe('CanvasViewer accessibility', () => {
  it('names the rendered canvas', () => {
    render(<CanvasViewer canvas={canvas} measure={fakeMeasure} label="Sprint board" />)
    expect(screen.getByRole('figure', { name: 'Sprint board' })).toBeTruthy()
  })

  it('falls back to a generic name when the host supplies none', () => {
    // The viewer cannot know the document's name — that lives in the
    // workspace, never in canvas content — so the caller owns the label and
    // this is only the floor.
    render(<CanvasViewer canvas={canvas} measure={fakeMeasure} />)
    expect(screen.getByRole('figure', { name: 'Canvas' })).toBeTruthy()
  })

  it('keeps the rendered text reachable rather than marking it presentational', () => {
    const { container } = render(<CanvasViewer canvas={canvas} measure={fakeMeasure} />)
    const figure = screen.getByRole('figure')
    expect(figure.getAttribute('aria-hidden')).toBeNull()
    expect(container.querySelector('svg text')?.textContent).toContain('Hello')
  })
})
