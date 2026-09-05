// ADR-0026 decision 2: a conversation is the anchored unit, so the surface it
// is anchored to is where it is read AND answered. Pressing a comment opens
// its card: the whole conversation, its lifecycle actions in the top-right,
// and a reply box already open — no menu, and no second gesture to reach the
// thing a reader came to do.
import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from '../../lib/spatial/commands.js'
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
  messages: [
    { id: 'm1', body: 'free note', createdAt: '2026-09-02T00:00:00.000Z' },
    {
      id: 'm2',
      body: 'already answered once',
      author: 'assistant',
      createdAt: '2026-09-02T01:00:00.000Z',
    },
  ],
}
/** A second conversation, far enough away to press without hitting the first. */
const OTHER: CanvasComment = {
  id: 'thread-other',
  x: 200,
  y: 200,
  text: 'another note',
  createdAt: '2026-09-02T00:00:00.000Z',
}
const OTHER_THREAD: CommentThread = {
  id: 'thread-other',
  anchor: { kind: 'spatial', x: 200, y: 200 },
  status: 'open',
  messages: [{ id: 'm3', body: 'another note', createdAt: '2026-09-02T00:00:00.000Z' }],
}
const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': { comments: [FREE, OTHER] },
}

function makeHost(threads: readonly CommentThread[] = [THREAD]) {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: start,
    commands: [],
  }
  let seq = 0
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          threads={threads}
          createId={() => {
            seq += 1
            return `id-${seq}`
          }}
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

function of(commands: readonly EditorCommand[], kind: EditorCommand['kind']) {
  return commands.filter((c) => c.kind === kind)
}

async function waitForComment(container: HTMLElement) {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
}

/** The bubble sits down-right of the anchor; +25/+20 lands inside it. */
function pressAt(root: HTMLElement, pointerId: number, x: number, y: number) {
  const r = root.getBoundingClientRect()
  const at = { pointerId, clientX: r.left + x, clientY: r.top + y }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
}
function pressBubble(root: HTMLElement, pointerId: number) {
  pressAt(root, pointerId, 625, 470)
}
function pressOtherBubble(root: HTMLElement, pointerId: number) {
  pressAt(root, pointerId, 225, 220)
}

it('a press opens the card with the conversation and a reply box already open', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)
  expect(container.querySelector('[data-testid="comment-card"]')).toBeNull()

  pressBubble(root, 1)

  const card = page.getByTestId('comment-card')
  await expect.element(card).toBeInTheDocument()
  // The whole conversation, not just the opening message the canvas draws.
  await expect.element(page.getByText('already answered once')).toBeInTheDocument()
  // The box is THERE, not behind a verb.
  await expect.element(page.getByLabelText('Reply')).toBeInTheDocument()
})

it('the card commits a reply from its own box', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  pressBubble(root, 2)
  const box = page.getByLabelText('Reply')
  await expect.element(box).toBeInTheDocument()
  await userEvent.click(box)
  await userEvent.keyboard('on it')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(of(latest.commands, 'reply-to-thread')).toHaveLength(1))
  const reply = of(latest.commands, 'reply-to-thread')[0]
  expect(reply).toMatchObject({ kind: 'reply-to-thread', threadId: 'thread-free' })
  expect(reply?.kind === 'reply-to-thread' ? reply.message.body : undefined).toBe('on it')
  // The opening message is untouched — a reply appends beside it.
  expect(latest.canvas['x-whiteboard']?.comments?.[0]?.text).toBe('free note')
})

it('Resolve sits on the card itself, not only in a menu', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  pressBubble(root, 3)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()
  await userEvent.click(page.getByRole('button', { name: 'Resolve' }))

  await vi.waitFor(() => expect(of(latest.commands, 'set-comment-resolved')).toHaveLength(1))
  expect(of(latest.commands, 'set-comment-resolved')[0]).toEqual({
    kind: 'set-comment-resolved',
    id: 'thread-free',
    resolved: true,
  })
})

it('the context menu drops Reply, since the card is where a reply is written', async () => {
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
  // Kept: reachable without opening the card, and by keyboard.
  expect(labels).toContain('Edit comment')
  expect(labels).toContain('Resolve')
  expect(labels).not.toContain('Reply')
})

it('an unsent draft does not follow the reader to the next conversation', async () => {
  const { Host, latest } = makeHost([THREAD, OTHER_THREAD])
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  pressBubble(root, 10)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()
  await userEvent.click(page.getByLabelText('Reply'))
  await userEvent.keyboard('meant for the first one')

  // Straight to another comment without sending. The card is one component
  // in one place, so its draft would otherwise survive the switch and be
  // committed against whichever thread is open when submit is pressed.
  pressOtherBubble(root, 11)
  await vi.waitFor(() =>
    expect((page.getByLabelText('Reply').element() as HTMLTextAreaElement).value).toBe(''),
  )

  await userEvent.click(page.getByLabelText('Reply'))
  await userEvent.keyboard('meant for the second')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() => expect(of(latest.commands, 'reply-to-thread')).toHaveLength(1))
  const reply = of(latest.commands, 'reply-to-thread')[0]
  expect(reply).toMatchObject({ kind: 'reply-to-thread', threadId: 'thread-other' })
  expect(reply?.kind === 'reply-to-thread' ? reply.message.body : undefined).toBe(
    'meant for the second',
  )
})

it('Escape shuts the card straight after it opens, with no click in between', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  pressBubble(root, 12)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()
  // No click first: opening has to leave focus somewhere the key reaches,
  // or the card carries a handler nothing can trigger.
  await userEvent.keyboard('{Escape}')

  await vi.waitFor(() => expect(container.querySelector('[data-testid="comment-card"]')).toBeNull())
})

it('a cancelled press on a comment opens nothing later', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForComment(container)

  const r = root.getBoundingClientRect()
  const at = { pointerId: 13, clientX: r.left + 625, clientY: r.top + 470 }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerCancel(root, at)
  // A later release somewhere else must not spend the cancelled press.
  fireEvent.pointerUp(root, { pointerId: 13, clientX: r.left + 50, clientY: r.top + 50 })

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')).not.toBeNull(),
  )
  expect(container.querySelector('[data-testid="comment-card"]')).toBeNull()
})
