// Reaching a connection or a line with the keyboard alone: Tab walks each node
// and then what leaves it, and the edge's own verbs (label, menu, delete) work
// from there; Escape steps back to the node it was reached from.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { canvasAnnouncement } from '../../lib/canvas-announcer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

beforeEach(async () => {
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe(''), { timeout: 4000 })
})

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'Web' }),
    textNode({ id: 'b', x: 400, y: 40, width: 120, height: 60, text: 'API' }),
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
  lines: [
    {
      id: 'l1',
      from: { kind: 'point', point: { x: 40, y: 300 } },
      to: { kind: 'point', point: { x: 300, y: 300 } },
    },
  ],
}

function mount() {
  const host = makeEditorHost({ initial: board })
  const { container } = render(<host.Host />)
  rootOf(container).focus()
  return { ...host, container }
}

const selectedOption = () =>
  page
    .getByRole('option', { selected: true })
    .elements()
    .map((el) => el.getAttribute('aria-label'))

it('Tab after a node selects its connection and announces its place', async () => {
  const { container } = mount()
  await userEvent.keyboard('{Tab}{Tab}')
  await vi.waitFor(() => expect(selectedOption()).toEqual(['Connection from Web to API']))
  await vi.waitFor(() =>
    expect(canvasAnnouncement()).toBe('Selected: Connection from Web to API (1 of 2)'),
  )
  expect(document.activeElement === rootOf(container)).toBe(true)
})

it('Tab reaches a free line after the last node, then leaves the canvas', async () => {
  const { container } = mount()
  await userEvent.keyboard('{Tab}{Tab}{Tab}{Tab}')
  await vi.waitFor(() => expect(selectedOption()).toEqual(['Line from empty space to empty space']))
  await userEvent.keyboard('{Tab}')
  expect(document.activeElement === rootOf(container)).toBe(false)
})

it('Enter on a selected connection opens its label editor', async () => {
  mount()
  await userEvent.keyboard('{Tab}{Tab}{Enter}')
  await expect.element(page.getByTestId('edge-label-editor')).toBeInTheDocument()
})

it('Shift+F10 on a selected connection opens its menu with focus inside', async () => {
  mount()
  await userEvent.keyboard('{Tab}{Tab}')
  await userEvent.keyboard('{Shift>}{F10}{/Shift}')
  await expect
    .element(page.getByRole('menu', { name: 'Actions for Connection from Web to API' }))
    .toBeInTheDocument()
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
})

it('Delete on a selected connection deletes it', async () => {
  const { latest } = mount()
  await userEvent.keyboard('{Tab}{Tab}{Delete}')
  await vi.waitFor(() => expect(latest.canvas.edges).toEqual([]))
  expect(latest.canvas.nodes.map((node) => node.id)).toEqual(['a', 'b'])
})

it('Escape on a connection reached by Tab returns to the node it left', async () => {
  mount()
  await userEvent.keyboard('{Tab}{Tab}{Escape}')
  await vi.waitFor(() => expect(selectedOption()).toEqual(['Web']))
})
