/**
 * The viewer's file-reference seams.
 *
 * This package is read-only and has no store, so it cannot resolve a
 * reference itself — the host does, and hands the resolution in as the
 * bundle a root builds, rebuilt from a wire (the core carries a wire).
 */

import { referenceSeamsFromWire, referenceWire } from '@kamiazya/whiteboard-canvas-render'
import { browserLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/browser-core'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'

/** The core the host hands the viewer, loaded as the page loads its own. */
const CORE = await browserLayoutCore()

const BODY = '# Weekly notes\n\nShipped it.'
const seamsOf = (entries: Record<string, { name?: string; body?: string }>) =>
  referenceSeamsFromWire(referenceWire(new Map(Object.entries(entries))))

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
      <CanvasViewer core={CORE} canvas={canvas} references={seamsOf({ notes: { body: BODY } })} />,
    )
    expect(svgText(container)).toContain('Weekly notes')
    expect(svgText(container)).toContain('Shipped')
  })

  it('renders the raw reference when no seam is supplied, exactly as before', () => {
    const { container } = render(<CanvasViewer core={CORE} canvas={canvas} />)
    expect(svgText(container)).toContain('notes')
    expect(svgText(container)).not.toContain('Weekly notes')
  })

  it('uses the resolved label instead of the raw reference', () => {
    const { container } = render(
      <CanvasViewer
        core={CORE}
        canvas={canvas}
        references={seamsOf({ notes: { name: 'Weekly' } })}
      />,
    )
    expect(svgText(container)).toContain('Weekly')
  })
})

describe('CanvasViewer comment bubbles resolve references as a node body does', () => {
  const board: SpatialCanvas = {
    nodes: [textNode({ id: 'a', x: 0, y: 0, width: 200, height: 60, text: 'a' })],
    edges: [],
  }
  const thread = (body: string) => ({
    id: 't1',
    anchor: { kind: 'spatial' as const, nodeIds: ['a'], x: 0, y: 0, width: 1, height: 1 },
    status: 'open' as const,
    messages: [{ id: 'm1', body }],
  })
  const references = referenceSeamsFromWire(
    referenceWire(new Map([['notes', { documentId: 'D-NOTES', name: 'Weekly notes' }]]), {
      resolveTitle: (id) => (id === 'D-NOTES' ? 'Weekly notes' : undefined),
    }),
  )

  it('draws the resolved title for a [[reference]] in a bubble, not the written brackets', () => {
    const { container } = render(
      <CanvasViewer
        core={CORE}
        canvas={board}
        references={references}
        threads={[thread('see [[notes]] first')]}
      />,
    )
    expect(svgText(container)).toContain('Weekly notes')
    expect(svgText(container)).not.toContain('[[')
  })
})
