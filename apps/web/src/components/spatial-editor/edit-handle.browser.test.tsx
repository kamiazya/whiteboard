// The visible path into text editing (OOUI: actions live on the object).
// Double-click works but announces nothing; this control is the discoverable
// route. Fired on click, not pointerdown — opening the editor inside a
// discrete pointerdown loses the focus fight with mousedown's default
// action (see SelectionOverlay's onEditRequest doc).
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello world' }],
  edges: [],
}

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme="light"
      />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

it('selecting a text node shows an Edit control; clicking it opens the editor', async () => {
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: { x: 200, y: 150 } })

  const editHandle = page.getByTestId('edit-handle')
  await expect.element(editHandle).toBeInTheDocument()

  await userEvent.click(editHandle)
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  expect(container.querySelector('textarea')?.value).toBe('hello world')
})

it('the Edit control is keyboard-operable (Enter opens the editor)', async () => {
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: { x: 200, y: 150 } })
  ;(page.getByTestId('edit-handle').element() as SVGElement & { focus(): void }).focus()
  await userEvent.keyboard('{Enter}')

  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
})

it('arrow keys nudge the selected node; Shift enlarges the step', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 200, y: 150 } })

  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  root.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }),
  )

  // Start (100,100); +8 right, +32 down.
  await vi.waitFor(() => {
    const rect = container.querySelector('svg rect[fill="#ffffff"]')
    expect(rect?.getAttribute('x')).toBe('108')
    expect(rect?.getAttribute('y')).toBe('132')
  })
})
