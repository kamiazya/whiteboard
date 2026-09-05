// ADR-0025: a comment's text is edited in place — "Edit comment" from the
// card a press opens on it, or from its context menu, opens the same inline
// compose bubble the create gesture uses, pre-filled, and commits one
// `set-comment-text`. Escape keeps the stored text.
//
// The double press this used to test is GONE (2026-09-04): a single press
// now opens the card, and the second press of a pair lands on that card,
// which stops propagation — so the pairing could never complete. The card's
// own top-right Edit is the successor, and it is what these cases drive.
import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from '../../lib/spatial/commands.js'
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
  messages: [{ id: 'm1', body: 'free note', createdAt: '2026-09-02T00:00:00.000Z' }],
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

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function textEdits(commands: readonly EditorCommand[]) {
  return commands.filter((c) => c.kind === 'set-comment-text')
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

it('the card Edit opens the compose bubble pre-filled; Ctrl+Enter commits set-comment-text', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  pressBubble(root, 1)
  await userEvent.click(page.getByRole('button', { name: 'Edit comment' }))
  const compose = page.getByTestId('comment-compose')
  await expect.element(compose).toBeInTheDocument()
  expect((compose.element() as HTMLTextAreaElement).value).toBe('free note')
  await vi.waitFor(() => expect(document.activeElement).toBe(compose.element()))
  await userEvent.keyboard(' revised')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(textEdits(latest.commands)).toHaveLength(1))
  expect(textEdits(latest.commands)[0]).toEqual({
    kind: 'set-comment-text',
    id: 'c-free',
    text: 'free note revised',
  })
  expect(latest.canvas['x-whiteboard']?.comments).toHaveLength(1)
  expect(container.querySelector('[data-testid="comment-compose"]')).toBeNull()
})

it('Escape abandons the edit and keeps the stored text', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  pressBubble(root, 2)
  await userEvent.click(page.getByRole('button', { name: 'Edit comment' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard(' nope')
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-compose"]')).toBeNull(),
  )
  expect(textEdits(latest.commands)).toHaveLength(0)
  expect(latest.canvas['x-whiteboard']?.comments?.[0]?.text).toBe('free note')
})

it('the context menu on a comment offers Edit comment, which opens the same pre-filled bubble', async () => {
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
  expect(labels).toContain('Edit comment')
  // A comment is not a node: none of the node verbs belong here.
  expect(labels).not.toContain('Delete')
  expect(labels).not.toContain('Comment here')

  await userEvent.click(page.getByRole('menuitem', { name: 'Edit comment' }))
  const compose = page.getByTestId('comment-compose')
  await expect.element(compose).toBeInTheDocument()
  expect((compose.element() as HTMLTextAreaElement).value).toBe('free note')
})
