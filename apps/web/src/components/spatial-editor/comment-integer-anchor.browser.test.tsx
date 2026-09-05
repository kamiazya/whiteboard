// A comment's stored anchor is an integer by contract (canvasCommentSchema),
// and a reader silently DROPS a comment that fails the schema — so a
// fractional anchor written from a zoomed viewport survives the session
// that wrote it and vanishes on the next undo, reload or remote import.
// Both editor writers of an anchor — the pin drag and "Comment here" — must
// therefore round what `screenToCanvas` hands them. Real browser at a
// non-integer zoom, which the default-zoom tests never exercise.
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import type { SpatialEditorHandle } from '../../lib/spatial/editor-handle.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const FREE: CanvasComment = {
  id: 'c-free',
  x: 600,
  y: 450,
  text: 'free note',
  createdAt: '2026-09-02T00:00:00.000Z',
}
const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': { comments: [FREE] },
}

function makeHost() {
  const latest: {
    canvas: SpatialCanvas
    commands: EditorCommand[]
    handle: SpatialEditorHandle | null
  } = { canvas: start, commands: [], handle: null }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          ref={(handle) => {
            latest.handle = handle
          }}
          defaultTool="select"
          canvas={canvas}
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

/** Zoom 1.3 puts every screen pixel at a fractional canvas coordinate. */
async function zoomTo13(container: HTMLElement, latest: { handle: SpatialEditorHandle | null }) {
  await vi.waitFor(() => expect(latest.handle).not.toBeNull())
  latest.handle?.setViewport({ x: 0, y: 0, zoom: 1.3 })
  // Wait for the zoom to reach the DOM, not just the state: the handlers
  // below read the viewport from the render closure.
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll('[style*="scale("]')].some((el) =>
        (el as HTMLElement).style.transform.includes('scale(1.3)'),
      ),
    ).toBe(true),
  )
}

it('a pin dragged at a fractional zoom commits an integer anchor', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
  await zoomTo13(container, latest)
  const r = root.getBoundingClientRect()
  // The pin is at canvas (600,450) = screen (780,585) at zoom 1.3.
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 780,
    clientY: r.top + 585,
  })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 719, clientY: r.top + 534 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 719, clientY: r.top + 534 })

  await vi.waitFor(() =>
    expect(latest.commands.filter((c) => c.kind === 'move-comment')).toHaveLength(1),
  )
  const move = latest.commands.find((c) => c.kind === 'move-comment')
  expect(move?.kind === 'move-comment' && Number.isInteger(move.x)).toBe(true)
  expect(move?.kind === 'move-comment' && Number.isInteger(move.y)).toBe(true)
})

it('Comment here at a fractional zoom commits an integer anchor', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await zoomTo13(container, latest)
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 401, clientY: r.top + 303, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment here' }))
  await expect.element(page.getByTestId('comment-compose')).toBeInTheDocument()
  await userEvent.keyboard('here')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() =>
    expect(latest.commands.filter((c) => c.kind === 'create-comment')).toHaveLength(1),
  )
  const created = latest.commands.find((c) => c.kind === 'create-comment')
  expect(created?.kind === 'create-comment' && Number.isInteger(created.comment.x)).toBe(true)
  expect(created?.kind === 'create-comment' && Number.isInteger(created.comment.y)).toBe(true)
})
