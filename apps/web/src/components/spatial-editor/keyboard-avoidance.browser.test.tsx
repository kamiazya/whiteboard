// On a phone, the virtual keyboard overlays the lower part of the screen
// without resizing the app shell, so a node being edited in that strip is
// simply hidden — edit mode with the subject invisible. The editor listens
// to visualViewport while a text edit is open and pans the canvas the least
// it can so the edited node (plus its exit-hint band) stays above the
// keyboard. Chromium cannot raise a real keyboard, so these tests install a
// fake visualViewport and shrink it the way a keyboard does.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { nodeEditorContent } from './node-editor-test-utils.js'
import { SpatialEditor } from './SpatialEditor.js'
import { EXIT_HINT_ALLOWANCE_PX } from './use-keyboard-avoidance.js'
import { PAN_MARGIN_PX } from './viewport.js'

afterEach(() => {
  cleanup()
  // Remove the shadowing own property so the real accessor returns.
  delete (window as { visualViewport?: unknown }).visualViewport
})

/** The subset the avoidance hook reads, over a real EventTarget. */
class FakeVisualViewport extends EventTarget {
  height = window.innerHeight
  offsetTop = 0
}

function installFakeVisualViewport(): FakeVisualViewport {
  const fake = new FakeVisualViewport()
  Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true })
  return fake
}

function canvasWithNodeAt(y: number): SpatialCanvas {
  return {
    nodes: [{ id: 'n1', type: 'text', x: 100, y, width: 200, height: 100, text: 'kbbody' }],
    edges: [],
  }
}

function Host({ start }: { start: SpatialCanvas }) {
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

function transformOf(container: HTMLElement): string {
  const layer = container.querySelector('[data-testid="viewport-transform"]') as HTMLElement
  return layer.style.transform
}

/** Shrinks the fake viewport so `visiblePx` of the editor root stays visible. */
function raiseKeyboard(fake: FakeVisualViewport, root: HTMLElement, visiblePx: number): void {
  fake.height = root.getBoundingClientRect().top + visiblePx
  fake.dispatchEvent(new Event('resize'))
}

async function startEditing(container: HTMLElement, at: { x: number; y: number }): Promise<void> {
  await userEvent.dblClick(rootOf(container), { position: at })
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
}

it('pans the canvas so a node hidden by the keyboard rises above it', async () => {
  const fake = installFakeVisualViewport()
  const { container } = render(<Host start={canvasWithNodeAt(400)} />)
  await startEditing(container, { x: 200, y: 450 })
  expect(transformOf(container)).toBe('scale(1) translate(0px, 0px)')

  raiseKeyboard(fake, rootOf(container), 300)

  // Node bottom (500) + hint band + margin must land at the 300px visible
  // strip's bottom: dy = 500 + allowance - (300 - margin).
  const dy = 500 + EXIT_HINT_ALLOWANCE_PX - (300 - PAN_MARGIN_PX)
  await vi.waitFor(() => expect(transformOf(container)).toBe(`scale(1) translate(0px, ${-dy}px)`))
})

it('does not pan when the visual viewport still shows the whole root', async () => {
  const fake = installFakeVisualViewport()
  const { container } = render(<Host start={canvasWithNodeAt(400)} />)
  await startEditing(container, { x: 200, y: 450 })

  fake.dispatchEvent(new Event('resize'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(transformOf(container)).toBe('scale(1) translate(0px, 0px)')
})

it('does not pan for a node already above the keyboard', async () => {
  const fake = installFakeVisualViewport()
  const { container } = render(<Host start={canvasWithNodeAt(100)} />)
  await startEditing(container, { x: 200, y: 150 })

  raiseKeyboard(fake, rootOf(container), 300)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(transformOf(container)).toBe('scale(1) translate(0px, 0px)')
})

it('stops listening once the edit ends', async () => {
  const fake = installFakeVisualViewport()
  const { container } = render(<Host start={canvasWithNodeAt(400)} />)
  await startEditing(container, { x: 200, y: 450 })
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() => expect(nodeEditorContent(container)).toBeNull())

  raiseKeyboard(fake, rootOf(container), 300)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(transformOf(container)).toBe('scale(1) translate(0px, 0px)')
})
