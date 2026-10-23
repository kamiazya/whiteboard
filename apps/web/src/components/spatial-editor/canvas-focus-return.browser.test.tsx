// After a verb finishes, the keyboard must still be on the canvas: focus left
// on <body> strands a keyboard user until they find the canvas again.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rightClick } from '../../test-utils/spatial-editor-pointer.js'
import { edgeMidpoint, rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 400, y: 100, width: 120, height: 60, text: 'B' }),
  ],
  edges: [],
}

const withEdge: SpatialCanvas = {
  ...board,
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
}

/** Focus is on the canvas root or inside it — wherever the traversal expects to continue from. */
function focusIsOnCanvas(container: HTMLElement): boolean {
  const root = rootOf(container)
  return document.activeElement !== null && root.contains(document.activeElement)
}

it('keeps the keyboard on the canvas after the dock groups the selection', async () => {
  const { Host, latest } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: { x: 160, y: 130 } })
  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Group' }))
  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(3))
  await vi.waitFor(() => expect(focusIsOnCanvas(container)).toBe(true))
})

it('keeps the keyboard on the canvas after a keyboard connect completes', async () => {
  const { Host, latest } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  rootOf(container).focus()
  await userEvent.keyboard('{Tab}')
  ;(page.getByTestId('connect-handle').element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByTestId('connect-target-b')).toBeInTheDocument()
  rootOf(container).focus()
  await userEvent.keyboard('{Tab}{Enter}')
  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(1))
  await vi.waitFor(() => expect(focusIsOnCanvas(container)).toBe(true))
})

it('keeps the keyboard on the canvas after Ctrl+Enter keeps an edge label', async () => {
  const { Host, latest } = makeEditorHost({ initial: withEdge })
  const { container } = render(<Host />)
  await userEvent.dblClick(rootOf(container), { position: edgeMidpoint(container) })
  const editor = page.getByRole('textbox', { name: /Label of edge/ })
  await expect.element(editor).toBeInTheDocument()
  await userEvent.fill(editor, 'yes')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() => expect(latest.canvas.edges[0]).toMatchObject({ label: 'yes' }))
  await vi.waitFor(() => expect(focusIsOnCanvas(container)).toBe(true))
})

it('keeps the keyboard on the canvas after Ctrl+Enter keeps a frame name', async () => {
  const framed: SpatialCanvas = {
    nodes: [groupNode({ id: 'g1', x: 80, y: 80, width: 360, height: 220, label: 'cluster' })],
    edges: [],
  }
  const { Host, latest } = makeEditorHost({ initial: framed })
  const { container } = render(<Host />)
  await userEvent.dblClick(rootOf(container), { position: { x: 100, y: 60 } })
  const editor = page.getByRole('textbox', { name: /Name of frame/ })
  await expect.element(editor).toBeInTheDocument()
  await userEvent.fill(editor, 'phase')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await vi.waitFor(() => expect(latest.canvas.nodes[0]).toMatchObject({ label: 'phase' }))
  await vi.waitFor(() => expect(focusIsOnCanvas(container)).toBe(true))
})

it('keeps the keyboard on the canvas after Escape closes the link dialog', async () => {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Link' }))
  await expect.element(page.getByRole('dialog')).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  await vi.waitFor(() => expect(focusIsOnCanvas(container)).toBe(true))
})

it('keeps the keyboard on the canvas after Escape discards an edge label', async () => {
  const { Host, latest } = makeEditorHost({ initial: withEdge })
  const { container } = render(<Host />)
  await userEvent.dblClick(rootOf(container), { position: edgeMidpoint(container) })
  const editor = page.getByRole('textbox', { name: /Label of edge/ })
  await expect.element(editor).toBeInTheDocument()
  await userEvent.fill(editor, 'no')
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="edge-label-editor"]')).toBeNull(),
  )
  expect(latest.canvas.edges[0]?.label).toBeUndefined()
  await vi.waitFor(() => expect(focusIsOnCanvas(container)).toBe(true))
})

it('keeps the keyboard on the canvas after Escape closes the context menu', async () => {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  rootOf(container).focus()
  rightClick(rootOf(container), 160, 130)
  await expect.element(page.getByRole('menu')).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  await vi.waitFor(() => expect(focusIsOnCanvas(container)).toBe(true))
})
