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

/**
 * A finger's tap on the bubble as a touch browser delivers it: the release
 * goes to the element the press implicitly captured — the bubble's own text
 * — EVEN IF that element has since left the document (iOS keeps delivering
 * to the original target). A press that pulled the bubble out of the surface
 * to arm its drag therefore never saw its release, and the stale press and
 * drag replayed on every later tap.
 */
function fingerTapAt(root: HTMLElement, x: number, y: number, pointerId: number) {
  const r = root.getBoundingClientRect()
  const clientX = r.left + x
  const clientY = r.top + y
  const target = document.elementFromPoint(clientX, clientY) ?? root
  const at = { pointerId, pointerType: 'touch', isPrimary: true, clientX, clientY }
  fireEvent.pointerDown(target, { button: 0, ...at })
  // The same node, whether or not it is still attached.
  fireEvent.pointerUp(target, at)
  return target
}

it('a finger opens the card on its FIRST tap, the release landing on the node it pressed', async () => {
  const { container } = render(<Host />)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
  const root = rootOf(container)
  const pressed = fingerTapAt(root, 625, 470, 21)
  // The press left the bubble in the document, so the release reached the root.
  expect(pressed.isConnected).toBe(true)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()

  // A tap on empty canvas shuts it, and nothing stale re-opens it at the release.
  fingerTapAt(root, 60, 560, 22)
  await vi.waitFor(() => expect(container.querySelector('[data-testid="comment-card"]')).toBeNull())
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(container.querySelector('[data-testid="comment-card"]')).toBeNull()

  // Re-opened, a tap on the reply box focuses it rather than moving the comment.
  fingerTapAt(root, 625, 470, 23)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()
  const box = page.getByLabelText('Reply').element() as HTMLElement
  const b = box.getBoundingClientRect()
  const rr = root.getBoundingClientRect()
  fingerTapAt(root, b.left - rr.left + b.width / 2, b.top - rr.top + b.height / 2, 24)
  box.focus()
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()
  expect(document.activeElement).toBe(box)
})
