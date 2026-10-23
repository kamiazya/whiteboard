// The dock's Group: with a selection it frames what is selected; with none it
// makes a named-on-arrival frame in free space, so it never lands invisible
// over existing work.

import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { isFrame } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
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

it('Group with a selected node frames it with padding and leaves no editor open', async () => {
  const { Host, latest } = makeEditorHost({ initial: populated })
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: { x: 400, y: 300 } })

  await chooseGroup()

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(2))
  expect(frameOf(latest.canvas)).toMatchObject({ x: 276, y: 226, width: 248, height: 148 })
  expect(container.querySelector('[data-testid="group-label-editor"]')).toBeNull()
})

it('Group with several selected nodes frames them all', async () => {
  const second = textNode({ id: 'b', x: 600, y: 400, width: 100, height: 60, text: 'two' })
  const { Host, latest } = makeEditorHost({ initial: { nodes: [centreNote, second], edges: [] } })
  const { container } = render(<Host />)
  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 400, y: 300 } })
  await userEvent.keyboard('{Shift>}')
  await userEvent.click(root, { position: { x: 650, y: 430 } })
  await userEvent.keyboard('{/Shift}')

  await chooseGroup()

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(3))
  expect(frameOf(latest.canvas)).toMatchObject({ x: 276, y: 226, width: 448, height: 258 })
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
