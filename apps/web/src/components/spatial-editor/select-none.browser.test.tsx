// The canvas is a drawing surface, not prose. A drag across it means marquee
// or pan, and Select All means "every node" — neither should leave the
// browser's own text selection painted over the chrome. Text stays selectable
// exactly where text is being edited.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { nodeEditorContent } from './node-editor-test-utils.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 40, y: 40, width: 200, height: 100, text: 'hello' }],
  edges: [],
}

function Host() {
  const [canvas, setCanvas] = useState(initial)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

const rootOf = (c: HTMLElement) => c.querySelector('[data-testid="spatial-editor"]') as HTMLElement

it('makes the canvas surface unselectable', () => {
  const { container } = render(<Host />)
  expect(getComputedStyle(rootOf(container)).userSelect).toBe('none')
})

it('keeps the text a node is being edited with selectable', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const at = { clientX: r.left + 140, clientY: r.top + 90 }

  // Double-press opens the editor (the editor's own detection, not dblclick).
  for (let i = 0; i < 2; i++) {
    fireEvent.pointerDown(root, { button: 0, pointerId: 1, ...at })
    fireEvent.pointerUp(root, { pointerId: 1, ...at })
  }

  await vi.waitFor(() => {
    const editor = nodeEditorContent(container)
    expect(editor).not.toBeNull()
    // Inherited `none` would leave the caret unable to select its own text.
    expect(getComputedStyle(editor as HTMLElement).userSelect).toBe('text')
  })
})
