// On a phone the canvas root cancels every `touchstart` that is not inside
// an overlay, which is what stops the platform claiming a pan as a scroll —
// and also what suppresses the `click` a tap would otherwise produce. A
// control the root does not recognise as an overlay is therefore dead to a
// finger while working under a mouse, which is how the card's Close button
// shipped unreachable on the one device where Escape does not exist.
import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const FREE: CanvasComment = {
  id: 'thread-free',
  x: 600,
  y: 450,
  text: 'free note',
  createdAt: '2026-09-02T00:00:00.000Z',
}
const THREAD: CommentThread = {
  id: 'thread-free',
  anchor: { kind: 'spatial', x: 600, y: 450 },
  status: 'open',
  messages: [{ id: 'm1', body: 'free note', createdAt: '2026-09-02T00:00:00.000Z' }],
}
const start: SpatialCanvas = {
  nodes: [],
  edges: [],
  'x-whiteboard': { comments: [FREE] },
}

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        threads={[THREAD]}
        onChange={(next) => setCanvas(next)}
        theme="light"
      />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

async function openCard(container: HTMLElement): Promise<void> {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const at = { pointerId: 7, clientX: r.left + 625, clientY: r.top + 470 }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()
}

/**
 * The root's refuser is a NATIVE non-passive listener, so a synthetic touch
 * through the real dispatch path reaches it exactly as a finger's would; a
 * cancelled `touchstart` is the platform's definition of "no click follows".
 */
function touchStartOn(target: Element): boolean {
  const touch = new Touch({ identifier: 1, target })
  const event = new TouchEvent('touchstart', {
    bubbles: true,
    cancelable: true,
    touches: [touch],
    targetTouches: [touch],
    changedTouches: [touch],
  })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

it("a finger's tap on the card's Close is not cancelled by the canvas root", async () => {
  const { container } = render(<Host />)
  await openCard(container)

  const close = page.getByRole('button', { name: 'Close' }).element()
  expect(touchStartOn(close)).toBe(false)
})

it('the same tap on the reply box keeps its native focus', async () => {
  const { container } = render(<Host />)
  await openCard(container)

  expect(touchStartOn(page.getByLabelText('Reply').element())).toBe(false)
})

it('a tap on the canvas surface itself is still refused, so a pan is never a page scroll', async () => {
  const { container } = render(<Host />)
  await openCard(container)

  const content = container.querySelector('[data-testid="canvas-content"]') as Element
  expect(touchStartOn(content)).toBe(true)
})
