/**
 * The canvas pin says how much is in its conversation, the way every other
 * surface that marks one already did.
 *
 * The rail's row, the source pane's gutter dot and the preview marker all
 * carry the count; the canvas was the last surface that did not, so a reader
 * crossing between them met the same conversation described two ways.
 *
 * The count is composed into the SCENE by `canvas-render`, not drawn by this
 * app, so the widget, the export and `wb_scene_render` get it for the same
 * reason they get the pin. What only this layer can say is that the editor
 * actually HANDS the layout its threads — the flat projection the canvas
 * stores carries one text and cannot know how many messages there are, so a
 * count on the canvas is a claim about the wiring, not about the renderer.
 */
import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const BUSY: CanvasComment = { id: 'thread-busy', x: 600, y: 450, text: 'does this hold?' }
const LONE: CanvasComment = { id: 'thread-lone', x: 200, y: 200, text: 'one remark' }

const CANVAS: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': { comments: [BUSY, LONE] },
}

function threadOf(id: string, messages: number): CommentThread {
  return {
    id,
    anchor: { kind: 'spatial', x: 600, y: 450 },
    status: 'open',
    messages: Array.from({ length: messages }, (_, i) => ({ id: `${id}-m${i}`, body: `m${i}` })),
  }
}

function mount(threads: readonly CommentThread[]) {
  return render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={CANVAS}
        threads={threads}
        createId={() => 'id-1'}
        onChange={vi.fn()}
        theme="light"
      />
    </div>,
  )
}

/** Every digit-only text run the canvas drew, which is what a count is. */
function digitsOnCanvas(container: HTMLElement): string[] {
  const content = container.querySelector('[data-testid="canvas-content"]')
  return [...(content?.querySelectorAll('text') ?? [])]
    .map((one) => (one.textContent ?? '').trim())
    .filter((text) => /^\d+$/.test(text))
}

it('draws the message count on a busy conversation pin, and none on a lone remark', async () => {
  const { container } = mount([threadOf('thread-busy', 4), threadOf('thread-lone', 1)])

  await vi.waitFor(
    () => {
      expect(digitsOnCanvas(container)).toEqual(['4'])
    },
    { timeout: 4000 },
  )
})

it('draws no count at all when the host hands the editor no threads', async () => {
  // The flat comments the canvas stores carry a text and no conversation, so
  // a host with no threads plane wired gets the pins it always got rather
  // than a count invented from nothing.
  const { container } = mount([])
  await vi.waitFor(
    () => {
      expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
        'does this hold?',
      )
    },
    { timeout: 4000 },
  )
  expect(digitsOnCanvas(container)).toEqual([])
})
