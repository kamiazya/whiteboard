// The hand tool is navigation-only for CONTENT: a press on a node pans. A
// comment is chrome, not content, and a reader panning around a canvas has
// as much reason to open a conversation as one selecting on it — so a press
// on comment chrome that never travels opens the card under the hand tool
// too, while one that travels is the pan it always was.
import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const FREE: CanvasComment = { id: 'thread-free', x: 600, y: 450, text: 'free note' }
const THREAD: CommentThread = {
  id: 'thread-free',
  anchor: { kind: 'spatial', x: 600, y: 450 },
  status: 'open',
  messages: [{ id: 'm1', body: 'free note' }],
}
const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': { comments: [FREE] },
}

function makeHost() {
  const latest: { commands: EditorCommand[] } = { commands: [] }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="hand"
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

const transformOf = (container: HTMLElement) =>
  (container.querySelector('[data-testid="viewport-transform"]') as HTMLElement).style.transform

async function ready(container: HTMLElement) {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
  const hand = container.querySelector('[data-testid="hand-tool-button"]') as HTMLElement
  expect(hand.getAttribute('aria-pressed')).toBe('true')
}

/** The bubble sits down-right of the anchor; +25/+20 lands inside it. */
const BUBBLE = { x: 625, y: 470 }

it('a press on a bubble that does not travel opens the card under the hand tool', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await ready(container)
  const r = root.getBoundingClientRect()
  const at = { pointerId: 1, clientX: r.left + BUBBLE.x, clientY: r.top + BUBBLE.y }
  const before = transformOf(container)
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)

  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()
  expect(transformOf(container)).toBe(before)
  expect(latest.commands).toEqual([])
})

it('a press on a bubble that travels is the pan it always was: no card, no move-comment', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await ready(container)
  const r = root.getBoundingClientRect()
  const before = transformOf(container)
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 2,
    clientX: r.left + BUBBLE.x,
    clientY: r.top + BUBBLE.y,
  })
  fireEvent.pointerMove(root, {
    pointerId: 2,
    clientX: r.left + BUBBLE.x - 80,
    clientY: r.top + BUBBLE.y - 60,
  })
  fireEvent.pointerUp(root, {
    pointerId: 2,
    clientX: r.left + BUBBLE.x - 80,
    clientY: r.top + BUBBLE.y - 60,
  })

  expect(transformOf(container)).not.toBe(before)
  // A card opens at the release, synchronously under fireEvent's act flush:
  // absent now is absent for good.
  expect(container.querySelector('[data-testid="comment-card"]')).toBeNull()
  expect(container.querySelector('[data-testid="comment-drag-preview"]')).toBeNull()
  expect(latest.commands).toEqual([])
})

it('a press on the canvas shuts the card and stays shut, even though it also pans', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await ready(container)
  const r = root.getBoundingClientRect()
  const at = { pointerId: 3, clientX: r.left + BUBBLE.x, clientY: r.top + BUBBLE.y }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()

  const away = { pointerId: 4, clientX: r.left + 60, clientY: r.top + 560 }
  fireEvent.pointerDown(root, { button: 0, ...away })
  fireEvent.pointerUp(root, away)
  // The stale re-open this guards against happened AT the release, which
  // fireEvent flushed before returning: shut now is shut for good.
  expect(container.querySelector('[data-testid="comment-card"]')).toBeNull()
})

const menuLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())

function touch(el: HTMLElement, type: string, x: number, y: number, pointerId = 7) {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: r.left + x,
      clientY: r.top + y,
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: type === 'pointerdown' ? 0 : -1,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  )
}

// Panning is not a reason to be unable to talk about what is on the canvas.
// The hand tool keeps CONTENT out of reach — a press pans, nothing selects,
// nothing edits — while the annotation layer stays reachable the way it is
// under Select: a right-click, or a stationary touch long-press, opens the
// menu with the comment verbs alone.
it('a right-click under the hand tool offers the annotation verbs alone, and selects nothing', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await ready(container)
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + 60, clientY: r.top + 560 })
  expect(menuLabels(container)).toEqual(['Comment here', 'Show resolved comments'])
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())

  // Over the node: its comment verb, and none of its edit verbs — and the
  // node is not selected by the press, since hand mode never selects.
  fireEvent.contextMenu(root, { clientX: r.left + 200, clientY: r.top + 150 })
  expect(menuLabels(container)).toEqual(['Comment on this'])
  expect(container.querySelector('[data-testid="selection-overlay"]')).toBeNull()
})

it('Comment here from the hand-tool menu composes and commits a point-anchored comment', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await ready(container)
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + 60, clientY: r.top + 560 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment here' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('seen while panning')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() =>
    expect(latest.commands.map((entry) => entry.kind)).toContain('create-comment'),
  )
  expect(latest.commands[0]).toMatchObject({
    kind: 'create-comment',
    comment: { x: 60, y: 560, text: 'seen while panning' },
  })
})

it('a stationary touch long-press under the hand tool opens the comment verbs, and lifting opens no card', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await ready(container)
  const before = transformOf(container)

  // On the bubble: the comment's own menu (its lifecycle), and the release
  // that follows the menu must not ALSO open the card — the press was
  // spent on the menu.
  touch(root, 'pointerdown', BUBBLE.x, BUBBLE.y)
  // Waited on as a condition: the menu is what the delay produces.
  await vi.waitFor(() => expect(menuLabels(container)).toEqual(['Edit comment', 'Resolve']), {
    timeout: 2000,
  })
  touch(root, 'pointerup', BUBBLE.x, BUBBLE.y)
  // Closing the menu is the condition waited on: a card the release had
  // opened would have rendered by the time the menu is gone, and a plain
  // dispatch outside act() commits its render a tick later than the event.
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())
  expect(container.querySelector('[data-testid="comment-card"]')).toBeNull()
  expect(transformOf(container)).toBe(before)
  expect(latest.commands).toEqual([])
})
