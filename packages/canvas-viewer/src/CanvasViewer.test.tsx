import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
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

  // The document props are the reason canvas-render grew SvgDocumentOptions:
  // without them the root is undimensioned and a browser sizes it arbitrarily.
  // Forwarding them is easy to break silently, so assert they reach the root.
  it('forwards width, height, padding and background into the rendered document', () => {
    const { getByTestId } = render(
      <CanvasViewer
        canvas={canvas}
        measure={fakeMeasure}
        testId="document-props"
        width={640}
        height={480}
        padding={10}
        background="#eef2ff"
      />,
    )
    // A distinct testId per render: renders are not cleaned up between tests
    // here, so reusing the default id would match an earlier test's element.
    const svg = getByTestId('document-props').querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('640')
    expect(svg?.getAttribute('height')).toBe('480')
    // padding expands the derived viewBox, so it must start left of the origin.
    const [viewBoxX] = (svg?.getAttribute('viewBox') ?? '').split(' ').map(Number)
    expect(viewBoxX).toBe(-10)
    // background renders as the document's first child rect.
    expect(svg?.firstElementChild?.getAttribute('fill')).toBe('#eef2ff')
  })

  it('falls back to the browser measurer when none is injected', () => {
    // Exercises the default `measure` branch, which every other test bypasses.
    expect(() => render(<CanvasViewer canvas={canvas} />)).not.toThrow()
    const { getByTestId } = render(<CanvasViewer canvas={canvas} testId="default-measure" />)
    expect(getByTestId('default-measure').querySelector('svg')).toBeTruthy()
  })
})
