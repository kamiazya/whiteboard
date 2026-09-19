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

import { referenceSeams } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'
import { mountCanvasViewer } from './mount.js'

const BODY = '# Weekly notes\n\nShipped it.'
const seamsOf = (entries: Record<string, { name?: string; body?: string }>) =>
  referenceSeams(new Map(Object.entries(entries)))

/**
 * TWO fixtures for one board, because this file drives two seams with
 * opposite contracts. `CanvasViewer` takes a `canvas` and renders it, so it
 * takes the MODEL. `mountCanvasViewer` PARSES its `scene`, so it takes the
 * JSON Canvas wire shape — `type` plus the kind's own field.
 *
 * They were one constant while the model WAS the format (ADR-0038 decision
 * 3 is what separated them), and a single fixture now silently fails
 * whichever seam it is not written for.
 */
const canvas: SpatialCanvas = {
  nodes: [fileNode({ id: 'f1', x: 0, y: 0, width: 320, height: 220, file: 'notes' })],
  edges: [],
}
const wireCanvas = {
  nodes: [{ id: 'f1', type: 'file', file: 'notes', x: 0, y: 0, width: 320, height: 220 }],
  edges: [],
}

const svgText = (root: HTMLElement) =>
  [...root.querySelectorAll('svg text')].map((node) => node.textContent ?? '').join(' ')

afterEach(cleanup)

describe('CanvasViewer file-reference seams', () => {
  it('renders a referenced markdown body when the host supplies one', () => {
    const { container } = render(
      <CanvasViewer canvas={canvas} references={seamsOf({ notes: { body: BODY } })} />,
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
      <CanvasViewer canvas={canvas} references={seamsOf({ notes: { name: 'Weekly' } })} />,
    )
    expect(svgText(container)).toContain('Weekly')
  })
})

describe('mountCanvasViewer references map', () => {
  it('turns the plain map into the resolvers, so the widget needs no functions', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const handle = mountCanvasViewer(container, {
      scene: wireCanvas,
      references: { notes: { name: 'Weekly', body: BODY } },
    })

    expect(svgText(container)).toContain('Weekly notes')
    handle.dispose()
    container.remove()
  })

  it('leaves the render untouched when the host supplies no map', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const handle = mountCanvasViewer(container, { scene: wireCanvas })

    expect(svgText(container)).toContain('notes')
    expect(svgText(container)).not.toContain('Weekly notes')
    handle.dispose()
    container.remove()
  })
})
