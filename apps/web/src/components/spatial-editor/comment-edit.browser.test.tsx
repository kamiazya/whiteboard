// A message is rewritten where it is DRAWN: in the card, on the message's
// own line, whichever message it is.
//
// ADR-0025 had a comment's text edited in place, through a pre-filled
// compose bubble reachable from the card's top-right Edit and from the
// comment's context menu. Both reached `messages[0]` and nothing else,
// because both wrote the flat comment's `text` — so a reply, on the one
// surface that can hold a conversation on a canvas, could not be corrected
// at all. That is retired here: one verb, on every message, writing
// `edit-thread-message` like the rail does.
//
// The double press this file used to test went in 2026-09-04: a single
// press opens the card, and the second press of a pair lands on that card,
// which stops propagation.
import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const FREE: CanvasComment = {
  id: 'c-free',
  x: 600,
  y: 450,
  text: 'free note',
  createdAt: '2026-09-02T00:00:00.000Z',
}
const THREAD: CommentThread = {
  id: 'c-free',
  anchor: { kind: 'spatial', x: 600, y: 450 },
  status: 'open',
  // TWO messages: the opening one, which the canvas draws as the flat
  // comment's text, and a reply, which it does not. The reply is the case
  // this surface could not reach.
  messages: [
    { id: 'm1', body: 'free note', createdAt: '2026-09-02T00:00:00.000Z' },
    { id: 'm2', body: 'noted', createdAt: '2026-09-02T01:00:00.000Z' },
  ],
}
const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': { comments: [FREE] },
}

function makeHost() {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: start,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          threads={[THREAD]}
          onChange={(next, command) => {
            latest.commands.push(command)
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

function messageEdits(commands: readonly EditorCommand[]) {
  return commands.filter((c) => c.kind === 'edit-thread-message')
}

async function waitForComment(container: HTMLElement) {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
}

/** The bubble sits down-right of the anchor; (625, 470) is inside it. */
function pressBubble(root: HTMLElement, pointerId: number) {
  const r = root.getBoundingClientRect()
  const at = { pointerId, clientX: r.left + 625, clientY: r.top + 470 }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
}

it('rewrites a REPLY from the card, the message this surface could not reach', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  pressBubble(root, 1)
  await userEvent.click(page.getByTestId('edit-m2'))
  const box = page.getByRole('textbox', { name: 'Edit message text' })
  await expect.element(box).toBeInTheDocument()
  await vi.waitFor(() => expect(box.element().contains(document.activeElement)).toBe(true))
  await userEvent.keyboard(' twice')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(messageEdits(latest.commands)).toHaveLength(1))
  const edit = messageEdits(latest.commands)[0]
  expect(edit).toMatchObject({ threadId: 'c-free', opening: false })
  expect(edit?.kind === 'edit-thread-message' ? edit.message : null).toMatchObject({
    id: 'm2',
    body: 'noted twice',
  })
})

it('rewrites the opening message the same way, saying it is the one the canvas draws', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  pressBubble(root, 1)
  await userEvent.click(page.getByTestId('edit-m1'))
  await vi.waitFor(() =>
    expect(page.getByRole('textbox', { name: 'Edit message text' }).query()).not.toBeNull(),
  )
  await userEvent.keyboard(' revised')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(messageEdits(latest.commands)).toHaveLength(1))
  // `opening` is what tells the canvas to repaint the pin's own text; the
  // flat comment carries the first message and only the first.
  expect(messageEdits(latest.commands)[0]).toMatchObject({ opening: true })
  await vi.waitFor(() =>
    expect(latest.canvas['x-whiteboard']?.comments?.[0]?.text).toBe('free note revised'),
  )
})

it('Escape abandons the edit and keeps the stored text, without shutting the card', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  pressBubble(root, 1)
  await userEvent.click(page.getByTestId('edit-m1'))
  await vi.waitFor(() =>
    expect(page.getByRole('textbox', { name: 'Edit message text' }).query()).not.toBeNull(),
  )
  await userEvent.keyboard(' revised')
  await userEvent.keyboard('{Escape}')

  // One layer at a time: the edit goes, the card stays. Leaving the card
  // would discard a draft nobody asked to discard.
  await vi.waitFor(() =>
    expect(page.getByRole('textbox', { name: 'Edit message text' }).query()).toBeNull(),
  )
  expect(page.getByTestId('comment-card').query()).not.toBeNull()
  expect(messageEdits(latest.commands)).toHaveLength(0)
  expect(latest.canvas['x-whiteboard']?.comments?.[0]?.text).toBe('free note')
})

it('offers no second way to edit from the comment context menu', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 625, clientY: r.top + 470, button: 2 })
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  const labels = [...container.querySelectorAll('[data-testid="context-menu"] button')].map(
    (el) => el.textContent,
  )
  // The conversation's own lifecycle stays here; editing moved onto the
  // message, where it can name WHICH message.
  expect(labels).toContain('Resolve')
  expect(labels).not.toContain('Edit comment')
  // A comment is not a node: none of the node verbs belong here.
  expect(labels).not.toContain('Delete')
})
