// ADR-0025 decision 2: a comment is closed by RESOLVING it — from the
// editor as well as from an agent — and resolved comments are a per-user
// show/hide toggle, each individually reopenable, so the lifecycle closes
// from the web without a delete anywhere. Real browser: the verbs live on
// the context menu over hit-tested chrome, and the toggle crosses to the
// layout worker on a large canvas.
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const OPEN: CanvasComment = {
  id: 'c-open',
  x: 500,
  y: 400,
  text: 'still open',
  createdAt: '2026-09-02T00:00:00.000Z',
}
const DONE: CanvasComment = {
  id: 'c-done',
  x: 300,
  y: 450,
  text: 'already resolved',
  createdAt: '2026-09-02T00:00:00.000Z',
  resolved: true,
}
const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': { comments: [OPEN, DONE] },
}

function makeHost(initial: SpatialCanvas = start) {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: initial,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
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

function pinOf(container: HTMLElement, id: string): SVGGElement | null {
  return container.querySelector(`[data-testid="canvas-content"] [data-wb-key="${id}/pin"]`)
}

function resolvesOf(commands: readonly EditorCommand[]) {
  return commands.filter((c) => c.kind === 'set-comment-resolved')
}

async function waitForPin(container: HTMLElement, id: string, present: boolean, timeout = 1000) {
  await vi.waitFor(
    () =>
      present
        ? expect(pinOf(container, id)).not.toBeNull()
        : expect(pinOf(container, id)).toBeNull(),
    { timeout },
  )
}

it('"Resolve" on a comment writes set-comment-resolved and the comment leaves the canvas', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForPin(container, 'c-open', true)
  // The resolved one is hidden by default.
  expect(pinOf(container, 'c-done')).toBeNull()

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 500, clientY: r.top + 400, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Resolve' }))

  await vi.waitFor(() => expect(resolvesOf(latest.commands)).toHaveLength(1))
  expect(resolvesOf(latest.commands)[0]).toEqual({
    kind: 'set-comment-resolved',
    id: 'c-open',
    resolved: true,
  })
  await waitForPin(container, 'c-open', false)
  // Closed, not erased: the record is still in the document.
  expect(latest.canvas['x-whiteboard']?.comments?.find((c) => c.id === 'c-open')).toMatchObject({
    resolved: true,
    text: 'still open',
  })
})

it('"Show resolved comments" draws resolved ones muted, and "Reopen" brings one back', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForPin(container, 'c-open', true)

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 700, clientY: r.top + 150, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Show resolved comments' }))
  await waitForPin(container, 'c-done', true)
  // Muted per the theme's resolvedOverlay, not hidden and not full-strength.
  const pinRect = pinOf(container, 'c-done')?.querySelector('rect')
  expect(Number.parseFloat(pinRect?.getAttribute('fill-opacity') ?? '1')).toBeLessThan(1)
  // The toggle is view state: nothing was written.
  expect(latest.commands).toHaveLength(0)

  fireEvent.contextMenu(root, { clientX: r.left + 300, clientY: r.top + 450, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Reopen' }))
  await vi.waitFor(() => expect(resolvesOf(latest.commands)).toHaveLength(1))
  expect(resolvesOf(latest.commands)[0]).toEqual({
    kind: 'set-comment-resolved',
    id: 'c-done',
    resolved: false,
  })
  await vi.waitFor(() =>
    expect(
      Number.parseFloat(
        pinOf(container, 'c-done')?.querySelector('rect')?.getAttribute('fill-opacity') ?? '1',
      ),
    ).toBe(1),
  )

  // And back off: the still-resolved set (none now) is hidden again.
  fireEvent.contextMenu(root, { clientX: r.left + 700, clientY: r.top + 150, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Hide resolved comments' }))
  await waitForPin(container, 'c-done', true)
})

// Twelve or more elements send layout to the worker: the toggle has to
// cross the wire as plain data, or a large canvas silently never shows a
// resolved comment.
const FILLER = Array.from({ length: 12 }, (_, i) => ({
  id: `f${i}`,
  type: 'text' as const,
  x: 20 + (i % 4) * 60,
  y: 520 + Math.floor(i / 4) * 30,
  width: 50,
  height: 24,
  text: `${i}`,
}))

it('the toggle reaches the layout worker on a large canvas', async () => {
  const { Host } = makeHost({ ...start, nodes: [...start.nodes, ...FILLER] })
  const { container } = render(<Host />)
  const root = rootOf(container)
  await waitForPin(container, 'c-open', true, 10_000)
  expect(pinOf(container, 'c-done')).toBeNull()

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 700, clientY: r.top + 150, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Show resolved comments' }))
  await waitForPin(container, 'c-done', true, 10_000)
}, 20_000)
