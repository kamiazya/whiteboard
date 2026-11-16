/**
 * The viewer's file-reference seams.
 *
 * This package is read-only and has no store, so it cannot resolve a
 * reference itself — the host does, and hands the resolution in as the
 * bundle `referenceSeams` builds.
 */

import { referenceSeams } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'

const BODY = '# Weekly notes\n\nShipped it.'
const seamsOf = (entries: Record<string, { name?: string; body?: string }>) =>
  referenceSeams(new Map(Object.entries(entries)))

const canvas: SpatialCanvas = {
  nodes: [fileNode({ id: 'f1', x: 0, y: 0, width: 320, height: 220, file: 'notes' })],
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
