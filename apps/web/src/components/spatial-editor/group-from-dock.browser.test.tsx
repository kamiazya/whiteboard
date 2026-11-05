// The dock's Group always makes a new, named-on-arrival frame in free space,
// so it never lands invisible over existing work nor wraps a selection the
// person did not ask to group — that is the menu's Group selection.

import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { isFrame } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const centreNote = textNode({ id: 'a', x: 300, y: 250, width: 200, height: 100, text: 'centre' })
const populated: SpatialCanvas = { nodes: [centreNote], edges: [] }

async function chooseGroup() {
  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Group' }))
}

function frameOf(canvas: SpatialCanvas): SpatialNode {
  const frame = canvas.nodes.find(isFrame)
  if (frame === undefined) throw new Error('no frame was created')
  return frame
}

const overlaps = (a: SpatialNode, b: SpatialNode) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

it('Group with a node selected makes a new frame beside it with its name editor focused', async () => {
  const { Host, latest } = makeEditorHost({ initial: populated })
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: { x: 400, y: 300 } })

  await chooseGroup()

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(2))
  expect(overlaps(frameOf(latest.canvas), centreNote)).toBe(false)
  const editor = container.querySelector('[data-testid="group-label-editor"]')
  expect(document.activeElement).toBe(editor)
})

it('Group with a frame selected does not nest, and its typed name fires no shortcut', async () => {
  const existing = groupNode({ id: 'g1', x: 200, y: 150, width: 320, height: 200, label: 'One' })
  const { Host, latest } = makeEditorHost({ initial: { nodes: [existing], edges: [] } })
  const { container } = render(<Host />)
  // The frame's border band selects it.
  await userEvent.click(rootOf(container), { position: { x: 202, y: 250 } })

  await chooseGroup()
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="group-label-editor"]'),
    ),
  )
  // H is the hand tool and N a new note when the canvas has the keys.
  await userEvent.keyboard('Hns{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(2))
  const created = latest.canvas.nodes.find((n) => n.id !== 'g1') as SpatialNode
  expect(created).toMatchObject({ label: 'Hns' })
  expect(overlaps(created, existing)).toBe(false)
})

it('Group with nothing selected lands in free space, selected, with its name editor focused', async () => {
  const { Host, latest } = makeEditorHost({ initial: populated })
  const { container } = render(<Host />)

  await chooseGroup()

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(2))
  expect(overlaps(frameOf(latest.canvas), centreNote)).toBe(false)
  const editor = container.querySelector('[data-testid="group-label-editor"]')
  expect(editor).not.toBeNull()
  expect(document.activeElement).toBe(editor)
  expect(editor?.getAttribute('placeholder')).toBe('Frame')
  expect(container.querySelectorAll('[data-testid="selection-overlay"]')).toHaveLength(1)
})

it("typing into the new frame's editor names it", async () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)

  await chooseGroup()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="group-label-editor"]')).not.toBeNull(),
  )
  await userEvent.keyboard('Edge tier{Control>}{Enter}{/Control}')

  await vi.waitFor(() => expect(frameOf(latest.canvas)).toMatchObject({ label: 'Edge tier' }))
})

it('an empty frame draws a faint fill so it stays visible', async () => {
  const { Host } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)

  await chooseGroup()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="group-label-editor"]')).not.toBeNull(),
  )
  await userEvent.keyboard('{Escape}')

  await vi.waitFor(() =>
    expect(
      container.querySelector('[data-testid="viewport-transform"] svg rect[fill-opacity]'),
    ).not.toBeNull(),
  )
})
