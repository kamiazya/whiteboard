import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'

// The returned queries are bound to document.body, so a render left mounted
// by the previous test (or the previous REPEAT of this one) answers too.
afterEach(cleanup)

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

/**
 * A standalone viewer must FRAME what it draws.
 *
 * `renderSceneToSvg` only emits the `width`/`height`/`viewBox` envelope when
 * asked for one — right for a scene composed into a larger document, and
 * wrong for every use of this component, which is a whole SVG in a browser.
 * Without it the root carries `xmlns` alone, the children keep raw scene
 * coordinates, and the browser lays the element out at the replaced-element
 * default: a canvas whose nodes start at x=400 renders as blank space with
 * one clipped corner.
 *
 * Measured on the emitted string before this was fixed: `<svg
 * xmlns="http://www.w3.org/2000/svg"><rect x="400" y="300" …` — no viewBox,
 * nothing to map those coordinates into the box on screen.
 */
describe('CanvasViewer frames what it draws', () => {
  const offCanvas: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 400, y: 300, width: 200, height: 80, text: 'far from origin' },
      { id: 'b', type: 'text', x: 700, y: 500, width: 200, height: 80, text: 'also far' },
    ],
    edges: [],
  }

  it('carries a viewBox around the content even when the host gives no size', () => {
    const { container } = render(<CanvasViewer canvas={offCanvas} measure={fakeMeasure} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()

    const viewBox = svg?.getAttribute('viewBox')
    expect(viewBox).not.toBeNull()
    const [x, y, w, h] = (viewBox ?? '').split(/\s+/).map(Number)
    // Framed ON the content: the box starts near the leftmost/topmost node
    // rather than at the origin, and is big enough to hold both.
    expect(x).toBeLessThanOrEqual(400)
    expect(x).toBeGreaterThan(300)
    expect(y).toBeLessThanOrEqual(300)
    expect(y).toBeGreaterThan(200)
    expect(w).toBeGreaterThanOrEqual(500)
    expect(h).toBeGreaterThanOrEqual(280)
  })

  it('still honours an explicit size from the host', () => {
    const { container } = render(
      <CanvasViewer canvas={offCanvas} measure={fakeMeasure} width={640} height={480} />,
    )
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('640')
    expect(svg?.getAttribute('height')).toBe('480')
    expect(svg?.getAttribute('viewBox')).not.toBeNull()
  })
})

describe('CanvasViewer draws the conversations it is handed', () => {
  it('outlines a node set from `threads`, which the flat comments in the canvas cannot carry', () => {
    const two: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'a' },
        { id: 'b', type: 'text', x: 200, y: 100, width: 100, height: 40, text: 'b' },
      ],
      edges: [],
    }
    const { container } = render(
      <CanvasViewer
        canvas={two}
        measure={fakeMeasure}
        threads={[
          {
            id: 'set',
            anchor: { kind: 'spatial', nodeIds: ['a', 'b'], x: 0, y: 0, width: 1, height: 1 },
            status: 'open',
            messages: [{ id: 'm', body: 'these' }],
          },
        ]}
      />,
    )
    const svg = container.innerHTML
    // The outline around the box both nodes occupy, dashed.
    expect(svg).toContain('<rect x="0" y="0" width="300" height="140"')
    expect(svg).toContain('stroke-dasharray="6 4"')
  })
})
