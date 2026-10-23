// The canvas is drawn, so a screen reader needs its contents handed over as
// named, selectable items and told what happened as the board changes.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { canvasAnnouncement } from '../../lib/canvas-announcer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

// One module-level channel that clears itself after a beat: the previous
// test's words must be gone before this one listens.
beforeEach(async () => {
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe(''), { timeout: 4000 })
})

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'Review' }),
    textNode({ id: 'b', x: 300, y: 40, width: 120, height: 60, text: 'Ship' }),
    groupNode({ id: 'g', x: 20, y: 200, width: 300, height: 160, label: 'cluster' }),
  ],
  edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, label: 'then' }],
}

function mount(initial: SpatialCanvas = board) {
  const host = makeEditorHost({ initial })
  const { container } = render(<host.Host />)
  rootOf(container).focus()
  return { ...host, container }
}

it('lists every node and edge by name in one labelled listbox', async () => {
  mount()
  await expect.element(page.getByRole('listbox', { name: 'Canvas contents' })).toBeInTheDocument()
  await expect.element(page.getByRole('option', { name: 'Review' })).toBeInTheDocument()
  await expect.element(page.getByRole('option', { name: 'Ship' })).toBeInTheDocument()
  await expect.element(page.getByRole('option', { name: 'Frame cluster' })).toBeInTheDocument()
  await expect
    .element(page.getByRole('option', { name: 'Edge from Review to Ship: then' }))
    .toBeInTheDocument()
})

it('Tab selects a node: its option is selected, the root points at it, and it is announced', async () => {
  const { container } = mount()
  await userEvent.keyboard('{Tab}')
  // Reading order: Review and Ship share a row, Review is left of it.
  const option = page.getByRole('option', { name: 'Review', selected: true })
  await expect.element(option).toBeInTheDocument()
  expect(rootOf(container).getAttribute('aria-activedescendant')).toBe(option.element().id)
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe('Selected: Review (1 of 3)'))
})

it('deleting a selected node announces it', async () => {
  mount()
  await userEvent.keyboard('{Tab}{Delete}')
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe('Deleted 1 node'))
})

it('adding a note from the dock announces it', async () => {
  mount({ nodes: [], edges: [] })
  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Note' }))
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe('Note added'))
})

it('grouping a selection announces how many nodes it framed', async () => {
  mount({
    nodes: [
      textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'A' }),
      textNode({ id: 'b', x: 200, y: 40, width: 120, height: 60, text: 'B' }),
    ],
    edges: [],
  })
  await userEvent.keyboard('{Control>}a{/Control}')
  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Group' }))
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe('Grouped 2 nodes'))
})
