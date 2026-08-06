// Edge creation from every side, not only the right — reported as friction
// after real use. Each handle starts the same connecting gesture; the edge's
// path is routed from geometry at layout time, so no side is persisted.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 300, y: 250, width: 160, height: 80, text: 'from' },
    { id: 'b', type: 'text', x: 60, y: 250, width: 120, height: 80, text: 'to-left' },
  ],
  edges: [],
}

function Host({ onCommand }: { onCommand: (kind: string) => void }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        canvas={canvas}
        onChange={(next, command) => {
          onCommand(command.kind)
          setCanvas(next)
        }}
        theme="light"
      />
    </div>
  )
}

it('renders a connect handle on every side of the selection', async () => {
  const { container } = render(<Host onCommand={() => {}} />)
  await userEvent.click(container.querySelector('[data-testid="spatial-editor"]') as Element, {
    position: { x: 380, y: 290 },
  })
  await expect.element(page.getByTestId('connect-handle')).toBeInTheDocument()
  for (const side of ['n', 's', 'w']) {
    await expect.element(page.getByTestId(`connect-handle-${side}`)).toBeInTheDocument()
  }
})

it('dragging from the LEFT handle onto another node creates an edge', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

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

  expect(commands).toContain('connect-nodes')
})
