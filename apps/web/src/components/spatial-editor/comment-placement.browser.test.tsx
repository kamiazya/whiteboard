// A comment's bubble does not cover a node — not the drawn bubble (that is
// canvas-render's placer, tested there) and not the DRAFT the editor opens
// before it exists: the compose bubble is placed by the same placer over
// the same obstacles, so it opens where the comment will settle. Real
// browser, because the compose box is DOM geometry over a rendered scene.
import { placeCommentBubble } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// A node immediately down-right of the spot a comment is left on: the
// fixed-offset draft used to open right over it.
const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 320, y: 320, width: 220, height: 120, text: 'covered' }],
  edges: [],
  'x-whiteboard': {
    comments: [
      {
        id: 'c-free',
        x: 300,
        y: 300,
        text: 'about this spot',
        createdAt: '2026-09-02T00:00:00.000Z',
      },
    ],
  },
}

function Host({ canvas: initial }: { canvas: SpatialCanvas }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

async function waitForContent(container: HTMLElement, text: string) {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(text),
  )
}

/** The compose box's canvas-space top-left, read from its inline style. */
function composeOrigin(): { x: number; y: number } {
  const el = page.getByTestId('comment-compose').element() as HTMLElement
  return { x: Number.parseFloat(el.style.left), y: Number.parseFloat(el.style.top) }
}

it('"Comment here" beside a node opens the draft in a free quadrant, not over the node', async () => {
  const { container } = render(<Host canvas={{ ...start, 'x-whiteboard': { comments: [] } }} />)
  const root = rootOf(container)
  await waitForContent(container, 'covered')
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 300, clientY: r.top + 300, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment here' }))

  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  const origin = composeOrigin()
  // Above the anchor: the down-right quadrant holds the node.
  expect(origin.y).toBeLessThan(300)
  expect(origin.x).toBeGreaterThan(300)
  // And exactly where canvas-render's placer puts a box of the draft's
  // size over the node — the draft and the settled bubble use one producer.
  // The draft's box is 216 x 64 (its width stays fixed; the height is the
  // one-line box it opens at, before the field grows with the text).
  const expected = placeCommentBubble({ x: 300, y: 300 }, { w: 216, h: 64 }, [
    { x: 320, y: 320, w: 220, h: 120 },
  ])
  expect(origin).toEqual({ x: expected.x, y: expected.y })
})

it('editing a comment opens the draft over its drawn bubble, in the same quadrant', async () => {
  const { container } = render(<Host canvas={start} />)
  const root = rootOf(container)
  await waitForContent(container, 'about this spot')
  const bubble = container.querySelector(
    '[data-testid="canvas-content"] [data-wb-key="c-free/bubble"] rect',
  ) as SVGRectElement
  const bubbleTop = Number.parseFloat(bubble.getAttribute('y') ?? 'NaN')
  // The drawn bubble is above the anchor (the node holds down-right)...
  expect(bubbleTop).toBeLessThan(300)

  // Through the context menu, which reaches the editor without opening the
  // card first — the subject here is where the DRAFT lands, and the card
  // would only add a step between the press and it.
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 300, clientY: r.top + 300, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Edit comment' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  // ...and so is the draft that replaces it.
  expect(composeOrigin().y).toBeLessThan(300)
})

it('the drag preview starts exactly on the drawn chrome, so pressing a pin does not jump the bubble', async () => {
  const { container } = render(<Host canvas={start} />)
  const root = rootOf(container)
  await waitForContent(container, 'about this spot')
  const drawn = (
    container.querySelector(
      '[data-testid="canvas-content"] [data-wb-key="c-free/bubble"] rect',
    ) as SVGRectElement
  ).getBoundingClientRect()

  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 2,
    clientX: r.left + 300,
    clientY: r.top + 300,
  })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  // A first move with no travel: the preview is up at delta zero.
  fireEvent.pointerMove(root, { pointerId: 2, clientX: r.left + 300, clientY: r.top + 300 })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).not.toBeNull(),
  )
  const preview = (
    container.querySelector(
      // The preview is a plain (unkeyed) render: the bubble is its rounded rect.
      '[data-testid="comment-drag-preview"] rect[rx="8"]',
    ) as SVGRectElement
  ).getBoundingClientRect()
  expect(Math.abs(preview.left - drawn.left)).toBeLessThan(1)
  expect(Math.abs(preview.top - drawn.top)).toBeLessThan(1)
  fireEvent.pointerCancel(root, { pointerId: 2 })
})
