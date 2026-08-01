import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'

const fakeMeasure: MeasureText = (text) => ({
  advanceWidth: text.length * 8,
  ascent: 12,
  descent: 4,
  lineGap: 0,
})

const canvas: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'hello' }],
  edges: [],
}

describe('CanvasViewer', () => {
  it('renders inside a container tagged with the given testId', () => {
    const { getByTestId } = render(
      <CanvasViewer canvas={canvas} measure={fakeMeasure} testId="my-viewer" />,
    )
    expect(getByTestId('my-viewer')).toBeTruthy()
  })

  it('injects a real <svg> element produced by canvas-render', () => {
    const { getByTestId } = render(<CanvasViewer canvas={canvas} measure={fakeMeasure} />)
    const svg = getByTestId('canvas-viewer').querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.querySelector('rect')).toBeTruthy()
  })

  it('renders an empty canvas without throwing', () => {
    const empty: SpatialCanvas = { nodes: [], edges: [] }
    expect(() => render(<CanvasViewer canvas={empty} measure={fakeMeasure} />)).not.toThrow()
  })
})
