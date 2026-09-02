// On a coarse pointer the exit strip under an editing node is two real
// buttons. The trap this pins: the editors COMMIT ON BLUR, so a tap that
// moved focus to the button would commit before the click could cancel —
// Cancel would silently mean Done. The buttons claim pointerdown so focus
// never leaves the editor, and the click then routes to the right verb.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownNodeEditor } from './MarkdownNodeEditor.js'
import { nodeEditorContent } from './node-editor-test-utils.js'
import { SpatialEditor } from './SpatialEditor.js'
import { TextNodeEditor } from './TextNodeEditor.js'

const BOX = { x: 20, y: 20, width: 240, height: 80 }
const realMatchMedia = window.matchMedia

beforeEach(() => {
  // The runner cannot emulate the media feature, so the query is answered
  // here; everything else about the pointer stays real.
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({ matches: true, media: query } as MediaQueryList)
      : realMatchMedia.call(window, query)
})

afterEach(() => {
  window.matchMedia = realMatchMedia
  cleanup()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

it('tapping Cancel on a markdown node editor cancels, and never commits', async () => {
  const onCommit = vi.fn()
  const onCancel = vi.fn()
  render(
    <MarkdownNodeEditor box={BOX} initialText="hello" onCommit={onCommit} onCancel={onCancel} />,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())

  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await settle()
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onCommit).not.toHaveBeenCalled()
})

it('tapping Done on a markdown node editor commits the text once', async () => {
  const onCommit = vi.fn()
  const onCancel = vi.fn()
  render(
    <MarkdownNodeEditor box={BOX} initialText="hello" onCommit={onCommit} onCancel={onCancel} />,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())
  await userEvent.keyboard(' there')

  await userEvent.click(screen.getByRole('button', { name: 'Done' }))
  await settle()
  expect(onCommit).toHaveBeenCalledTimes(1)
  expect(onCommit).toHaveBeenCalledWith('hello there')
  expect(onCancel).not.toHaveBeenCalled()
})

it('tapping Cancel on a plain text editor cancels, and never commits', async () => {
  const onCommit = vi.fn()
  const onCancel = vi.fn()
  render(<TextNodeEditor box={BOX} initialText="label" onCommit={onCommit} onCancel={onCancel} />)
  await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('TEXTAREA'))

  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await settle()
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onCommit).not.toHaveBeenCalled()
})

// Inside the canvas root the trap has a second half: the root refuses
// native touch and captures the pointer on any press it does not recognise
// as an overlay's, which retargets the click away from the button. The
// strip carries `data-editor-overlay` so the root leaves the tap alone —
// only a full editor mount can see that, which is why this test exists.
function Host({ start }: { start: SpatialCanvas }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

it('inside the spatial editor, tapping Cancel drops the draft and closes the editor', async () => {
  const start: SpatialCanvas = {
    nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'kept' }],
    edges: [],
  }
  const { container } = render(<Host start={start} />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await userEvent.dblClick(root, { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  await userEvent.keyboard(' draft')
  // Mirrors node-tools: hangs off the node's bottom-RIGHT corner.
  const pill = screen.getByTestId('editor-exit-hint').getBoundingClientRect()
  expect(pill.right - root.getBoundingClientRect().left).toBeCloseTo(300, 0)
  expect(pill.height).toBeCloseTo(26, 0)

  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await vi.waitFor(() => expect(nodeEditorContent(container)).toBeNull())
  const svgText = [...container.querySelectorAll('svg')]
    .map((svg) => svg.textContent ?? '')
    .join(' ')
  expect(svgText).toContain('kept')
  expect(svgText).not.toContain('draft')
})
