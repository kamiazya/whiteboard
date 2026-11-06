// What a screen-reader reader hears when a comment write lands on a canvas.
// The compose bubble or reply box that held focus is gone after the commit,
// and a new pin is not announced by being drawn, so the canvas's live region
// is the only place the outcome exists for them. Same words as the comments
// panel, so a note and a canvas say the same thing for the same act.

import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { announceOnCanvas, canvasAnnouncement } from '../../lib/canvas-announcer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)
// The channel is module-level and holds its text for a beat, so one test's
// announcement would otherwise satisfy the next one's assertion.
beforeEach(() => announceOnCanvas(''))

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
  nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' })],
  edges: [],
}
const withComment: SpatialCanvas = { ...start, comments: [FREE] }

function at(root: HTMLElement, x: number, y: number) {
  const r = root.getBoundingClientRect()
  return { clientX: r.left + x, clientY: r.top + y }
}

/** The bubble sits down-right of the anchor; +25/+20 lands inside it. */
function pressBubble(root: HTMLElement, pointerId: number) {
  const point = { pointerId, ...at(root, 625, 470) }
  fireEvent.pointerDown(root, { button: 0, ...point })
  fireEvent.pointerUp(root, point)
}

async function waitForComment(container: HTMLElement) {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
}

it('posting a new canvas comment is announced', async () => {
  const { Host } = makeEditorHost({ initial: start })
  const { container } = render(<Host />)
  fireEvent.contextMenu(rootOf(container), { button: 2, ...at(rootOf(container), 600, 450) })
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment here' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('split this')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(canvasAnnouncement().trim()).toBe('Comment posted'))
})

it('a reply sent from the card is announced', async () => {
  const { Host } = makeEditorHost({ initial: withComment, editorProps: { threads: [THREAD] } })
  const { container } = render(<Host />)
  await waitForComment(container)
  pressBubble(rootOf(container), 1)
  const box = page.getByLabelText('Reply')
  await userEvent.click(box)
  await userEvent.keyboard('on it')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(canvasAnnouncement().trim()).toBe('Reply sent'))
})

it('Resolve on the card is announced', async () => {
  const { Host } = makeEditorHost({ initial: withComment, editorProps: { threads: [THREAD] } })
  const { container } = render(<Host />)
  await waitForComment(container)
  pressBubble(rootOf(container), 2)
  await userEvent.click(page.getByRole('button', { name: 'Resolve' }))

  await vi.waitFor(() => expect(canvasAnnouncement().trim()).toBe('Conversation resolved'))
})

it('Resolve from the context menu is announced', async () => {
  const { Host } = makeEditorHost({ initial: withComment })
  const { container } = render(<Host />)
  await waitForComment(container)
  fireEvent.contextMenu(rootOf(container), { button: 2, ...at(rootOf(container), 625, 470) })
  await userEvent.click(page.getByRole('menuitem', { name: 'Resolve' }))

  await vi.waitFor(() => expect(canvasAnnouncement().trim()).toBe('Conversation resolved'))
})
