// Reaching existing nodes with the keyboard alone: Tab through reading order,
// a chord to the nearest neighbour, Enter/F2 to edit, Escape to let go.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'low', x: 40, y: 300, width: 120, height: 60, text: 'Low' }),
    textNode({ id: 'right', x: 400, y: 40, width: 120, height: 60, text: 'Right' }),
    textNode({ id: 'left', x: 40, y: 40, width: 120, height: 60, text: 'Left' }),
  ],
  edges: [],
}

/** Which node is selected, read the way a person would: press a nudge and see who moves. */
async function selectedId(latest: { canvas: SpatialCanvas }): Promise<string | undefined> {
  const before = latest.canvas
  await userEvent.keyboard('{ArrowDown}')
  const moved = latest.canvas.nodes.find(
    (n) => n.y !== (before.nodes.find((b) => b.id === n.id)?.y ?? n.y),
  )
  await userEvent.keyboard('{ArrowUp}')
  return moved?.id
}

function mount() {
  const host = makeEditorHost({ initial: board })
  const { container } = render(<host.Host />)
  rootOf(container).focus()
  return { ...host, container }
}

it('Tab selects the first node in reading order and keeps focus on the canvas', async () => {
  const { latest, container } = mount()
  await userEvent.keyboard('{Tab}')
  expect(await selectedId(latest)).toBe('left')
  expect(document.activeElement === rootOf(container)).toBe(true)
})

it('Tab and Shift+Tab cycle through the nodes and wrap', async () => {
  const { latest } = mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Tab}')
  expect(await selectedId(latest)).toBe('right')
  await userEvent.keyboard('{Tab}')
  expect(await selectedId(latest)).toBe('low')
  await userEvent.keyboard('{Tab}')
  expect(await selectedId(latest)).toBe('left')
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
  expect(await selectedId(latest)).toBe('low')
})

it('Ctrl+Arrow moves the selection to the nearest node that way without nudging', async () => {
  const { latest } = mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Control>}{ArrowRight}{/Control}')
  expect(latest.kinds).toEqual([])
  expect(await selectedId(latest)).toBe('right')
  await userEvent.keyboard('{Control>}{ArrowLeft}{/Control}')
  await userEvent.keyboard('{Control>}{ArrowDown}{/Control}')
  expect(await selectedId(latest)).toBe('low')
})

it('Enter and F2 open the in-place editor of the selected text node', async () => {
  const { container } = mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"]')).toBeTruthy(),
  )
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"]')).toBeNull(),
  )
  rootOf(container).focus()
  await userEvent.keyboard('{F2}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"]')).toBeTruthy(),
  )
})

it('Escape clears the selection, and the next Tab is left to the browser', async () => {
  const { latest, container } = mount()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Escape}')
  expect(await selectedId(latest)).toBeUndefined()
  await userEvent.keyboard('{Tab}')
  expect(document.activeElement === rootOf(container)).toBe(false)
  expect(latest.kinds).toEqual([])
})

it('Enter on a focused dock button presses the button instead of editing the node', async () => {
  const { container, latest } = mount()
  await userEvent.keyboard('{Tab}')
  const hand = container.querySelector('[data-testid="hand-tool-button"]') as HTMLElement
  hand.focus()
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(hand.getAttribute('aria-pressed')).toBe('true'))
  expect(container.querySelector('[data-testid="text-node-editor"]')).toBeNull()
  expect(latest.kinds).toEqual([])
})
