// The drag preview must carry the node's REAL content, not just a dashed
// outline — user verdict on the outline-only version: still stressful,
// "the drawing does not travel". The content is rendered once at drag
// start (single-node render, ~0.4ms) and travels via a per-frame CSS
// transform; the committed full-canvas render stays untouched during the
// drag, which is the property that keeps this smooth on large documents.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { press } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'travelling text' })],
  edges: [],
}

const { Host } = makeEditorHost({ initial: start })

it('the drag preview shows the node content itself, translated with the pointer', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  press(root, 'pointerdown', 200, 150)
  // Let React commit the 'moving' state before the move event: the move
  // handler reads gestureState from its render closure, so a move dispatched
  // in the same tick as the down still sees 'idle' and bails.
  await new Promise((r) => requestAnimationFrame(r))
  press(root, 'pointermove', 260, 190)
  await vi.waitFor(() => {
    const preview = container.querySelector('[data-testid="drag-preview"]')
    expect(preview).not.toBeNull()
    // Real content, not an outline: the node's text travels with the preview.
    expect(preview?.textContent).toContain('travelling text')
    // Motion is a pure transform of the once-rendered fragment.
    expect((preview as HTMLElement).style.transform).toContain('translate')
  })

  press(root, 'pointerup', 260, 190)
  // Preview gone after commit; the node itself moved by the delta.
  await vi.waitFor(() => expect(container.querySelector('[data-testid="drag-preview"]')).toBeNull())
})
