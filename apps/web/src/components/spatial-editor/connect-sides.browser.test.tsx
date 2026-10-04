// Edge creation from every side, not only the right — reported as friction
// after real use. Each handle starts the same connecting gesture; the edge's
// path is routed from geometry at layout time, so no side is persisted.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 300, y: 250, width: 160, height: 80, text: 'from' }),
    textNode({ id: 'b', x: 60, y: 250, width: 120, height: 80, text: 'to-left' }),
  ],
  edges: [],
}

it('renders a connect handle on every side of the selection', async () => {
  const { Host } = makeEditorHost({ initial: start })
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), {
    position: { x: 380, y: 290 },
  })
  await expect.element(page.getByTestId('connect-handle')).toBeInTheDocument()
  for (const side of ['n', 's', 'w']) {
    await expect.element(page.getByTestId(`connect-handle-${side}`)).toBeInTheDocument()
  }
})

it('dragging from the LEFT handle onto another node creates an edge', async () => {
  const { Host, latest } = makeEditorHost({ initial: start })
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Select node "a", then drag from its west handle to node "b".
  await userEvent.click(root, { position: { x: 380, y: 290 } })
  const west = page.getByTestId('connect-handle-w')
  await expect.element(west).toBeInTheDocument()

  const westEl = west.element() as SVGCircleElement
  const rootRect = root.getBoundingClientRect()
  await westEl.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: rootRect.left + 295,
      clientY: rootRect.top + 290,
      pointerId: 80,
      button: 0,
    }),
  )
  await root.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      clientX: rootRect.left + 120,
      clientY: rootRect.top + 290,
      pointerId: 80,
    }),
  )

  expect(latest.kinds).toContain('connect-nodes')
})
