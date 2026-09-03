// The canvas's verb strip: under the header, for the duration of an edit.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { nodeEditorText } from '../spatial-editor/node-editor-test-utils.js'
import { SpatialEditor } from '../spatial-editor/SpatialEditor.js'
import { CanvasVerbBar } from './CanvasVerbBar.js'

const realMatchMedia = window.matchMedia
afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
})

function stubCoarsePointer(): void {
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({ matches: true, media: query } as MediaQueryList)
      : realMatchMedia.call(window, query)
}

const bar = () => document.querySelector('[data-testid="canvas-verb-bar"]')

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>({
    nodes: [{ id: 'n1', type: 'text', x: 100, y: 300, width: 240, height: 100, text: 'milk' }],
    edges: [],
  })
  return (
    <div style={{ width: 800, height: 600, position: 'relative' }}>
      <CanvasVerbBar />
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

it('appears only while a node is being edited, and acts on it without closing the edit', async () => {
  const { container } = render(<Host />)
  expect(bar()).toBeNull()

  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await userEvent.dblClick(root, { position: { x: 200, y: 350 } })
  await vi.waitFor(() => expect(nodeEditorText(container)).not.toBeNull())
  await vi.waitFor(() => expect(bar()).not.toBeNull())

  // The verb acts on the caret's word, so no selection is made first.
  await userEvent.keyboard('{Home}{ArrowRight}{ArrowRight}')
  const bold = bar()?.querySelector('button[aria-label="Bold"]') as HTMLElement
  await userEvent.click(bold)
  await vi.waitFor(() => expect(nodeEditorText(container)).toBe('**milk**'))
  // The strip is a formatting surface, not an exit: the edit is still open.
  expect(bar()).not.toBeNull()

  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(bar()).toBeNull())
})

it('stays away on a coarse pointer, where the keyboard-docked bar has the job', async () => {
  // Both would otherwise show at once on a phone: this strip eating canvas
  // under the header while TouchFormattingBar rides the keyboard.
  stubCoarsePointer()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await userEvent.dblClick(root, { position: { x: 200, y: 350 } })
  await vi.waitFor(() => expect(nodeEditorText(container)).not.toBeNull())
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(bar()).toBeNull()
})
