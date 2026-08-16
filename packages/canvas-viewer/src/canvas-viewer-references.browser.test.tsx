/**
 * The viewer's file-reference seams, and the plain-data form the imperative
 * mount API takes them in.
 *
 * This package is read-only and has no store, so it cannot resolve a
 * reference itself — the host does. Its host is the MCP Apps widget, which
 * gets `references` from `canvas_view`'s payload; `mountCanvasViewer` takes
 * that map because a function cannot cross the host boundary the widget
 * sits behind.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'
import { mountCanvasViewer } from './mount.js'

const BODY: MdastRoot = {
  type: 'root',
  children: [
    { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Weekly notes' }] },
    { type: 'paragraph', children: [{ type: 'text', value: 'Shipped it.' }] },
  ],
}

const canvas: SpatialCanvas = {
  nodes: [{ id: 'f1', type: 'file', x: 0, y: 0, width: 320, height: 220, file: 'notes' }],
  edges: [],
}

const svgText = (root: HTMLElement) =>
  [...root.querySelectorAll('svg text')].map((node) => node.textContent ?? '').join(' ')

afterEach(cleanup)

describe('CanvasViewer file-reference seams', () => {
  it('renders a referenced markdown body when the host supplies one', () => {
    const { container } = render(
      <CanvasViewer
        canvas={canvas}
        resolveReference={(ref) => (ref === 'notes' ? { markdown: BODY } : undefined)}
      />,
    )
    expect(svgText(container)).toContain('Weekly notes')
    expect(svgText(container)).toContain('Shipped')
  })

  it('renders the raw reference when no seam is supplied, exactly as before', () => {
    const { container } = render(<CanvasViewer canvas={canvas} />)
    expect(svgText(container)).toContain('notes')
    expect(svgText(container)).not.toContain('Weekly notes')
  })

  it('uses the resolved label instead of the raw reference', () => {
    const { container } = render(
      <CanvasViewer canvas={canvas} resolveReference={() => ({ label: 'Weekly' })} />,
    )
    expect(svgText(container)).toContain('Weekly')
  })
})

describe('mountCanvasViewer references map', () => {
  it('turns the plain map into the resolvers, so the widget needs no functions', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const handle = mountCanvasViewer(container, {
      scene: canvas,
      references: { notes: { label: 'Weekly', body: BODY } },
    })

    expect(svgText(container)).toContain('Weekly notes')
    handle.dispose()
    container.remove()
  })

  it('leaves the render untouched when the host supplies no map', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const handle = mountCanvasViewer(container, { scene: canvas })

    expect(svgText(container)).toContain('notes')
    expect(svgText(container)).not.toContain('Weekly notes')
    handle.dispose()
    container.remove()
  })
})
