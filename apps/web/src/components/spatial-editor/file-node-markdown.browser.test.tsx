/**
 * The verified user flow, locked in: a file node pointing at a markdown
 * document in the same workspace renders that document's prose inside the
 * node, at the size the app itself creates.
 *
 * Real browser rather than jsdom, because what is being asserted is what
 * canvas-render measured and painted — text placement through the real
 * Canvas 2D measurer, into real SVG. Both halves were verified by hand in
 * the running app first; the second one is the reason this file exists, and
 * every unit test passed while it was broken.
 */

import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DOCUMENT_NODE_HEIGHT, DOCUMENT_NODE_WIDTH } from './node-factories.js'
import { SpatialEditor } from './SpatialEditor.js'

const BODY = parseMarkdownBody(
  '# Weekly notes\n\nShipped the markdown file node.\n\n- image beats markdown\n',
)

const CARD = { title: 'the facet card title', rows: [{ label: 'type', value: 'note' }] }

/** A file node at exactly the geometry `fileNodeDefaults` gives a markdown reference. */
function canvasWithDocumentNode(): SpatialCanvas {
  return {
    nodes: [
      {
        id: 'f1',
        type: 'file',
        x: 40,
        y: 40,
        width: DOCUMENT_NODE_WIDTH,
        height: DOCUMENT_NODE_HEIGHT,
        file: 'notes',
      },
    ],
    edges: [],
  }
}

const svgText = (container: HTMLElement) =>
  [...container.querySelectorAll('svg text')].map((node) => node.textContent ?? '').join(' ')

afterEach(cleanup)

describe('a file node referencing a markdown document', () => {
  it('renders the referenced body at the default document-node size', async () => {
    const { container } = render(
      <SpatialEditor
        canvas={canvasWithDocumentNode()}
        onChange={() => {}}
        resolveReference={(ref) => (ref === 'notes' ? { markdown: BODY } : undefined)}
      />,
    )

    await waitFor(() => expect(svgText(container)).toContain('Weekly notes'))
    expect(svgText(container)).toContain('Shipped')
    expect(svgText(container)).toContain('image beats markdown')
  })

  it('outranks the facet card, which says what the document is and not what it says', async () => {
    const { container } = render(
      <SpatialEditor
        canvas={canvasWithDocumentNode()}
        onChange={() => {}}
        resolveReference={() => ({ markdown: BODY, facets: CARD })}
      />,
    )

    await waitFor(() => expect(svgText(container)).toContain('Weekly notes'))
    expect(svgText(container)).not.toContain('the facet card title')
  })

  it('keeps the facet card when the reference resolves to no body', async () => {
    const { container } = render(
      <SpatialEditor
        canvas={canvasWithDocumentNode()}
        onChange={() => {}}
        resolveReference={() => ({ facets: CARD })}
      />,
    )

    await waitFor(() => expect(svgText(container)).toContain('the facet card title'))
  })

  it('paints nothing below the node box, however long the body', async () => {
    const long = parseMarkdownBody(
      Array.from({ length: 60 }, (_, i) => `paragraph number ${i}`).join('\n\n'),
    )
    const { container } = render(
      <SpatialEditor
        canvas={canvasWithDocumentNode()}
        onChange={() => {}}
        resolveReference={() => ({ markdown: long })}
      />,
    )

    await waitFor(() => expect(svgText(container)).toContain('paragraph number 0'))
    const bottom = 40 + DOCUMENT_NODE_HEIGHT
    for (const node of container.querySelectorAll('svg text')) {
      const y = Number((node as SVGTextElement).getAttribute('y') ?? '0')
      // The label sits ABOVE the frame, so only content below the top edge
      // is bounded by the box.
      if (y > 40) expect(y).toBeLessThanOrEqual(bottom)
    }
  })
})
