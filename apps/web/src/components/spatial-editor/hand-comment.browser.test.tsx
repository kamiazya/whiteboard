// The hand tool is navigation-only for CONTENT: a press on a node pans. A
// comment is chrome, not content, and a reader panning around a canvas has
// as much reason to open a conversation as one selecting on it — so a press
// on comment chrome that never travels opens the card under the hand tool
// too, while one that travels is the pan it always was.
import type { CanvasComment, CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
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
