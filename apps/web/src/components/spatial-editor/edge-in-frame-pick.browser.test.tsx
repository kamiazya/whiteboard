// An edge drawn inside a frame is still an edge: the frame's interior must
// not swallow the press that was aimed at the relation crossing it.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rightClick } from '../../test-utils/spatial-editor-pointer.js'
import { edgeMidpoint, rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const framed: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'frame', x: 40, y: 40, width: 560, height: 260, label: 'Group' }),
    textNode({ id: 'a', x: 80, y: 120, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 440, y: 120, width: 120, height: 60, text: 'B' }),
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
}

const edgeHighlight = (c: HTMLElement) =>
  c.querySelector('[data-testid="edge-selection-highlight"]')
const nodeSelection = (c: HTMLElement) => c.querySelector('[data-testid="selection-overlay"]')

it('a click on an edge inside a frame selects the edge, not the frame', async () => {
  const { Host } = makeEditorHost({ initial: framed })
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: edgeMidpoint(container) })
  await vi.waitFor(() => expect(edgeHighlight(container)).not.toBeNull())
  expect(nodeSelection(container)).toBeNull()
})

it('a right-click on an edge inside a frame opens the edge menu', async () => {
  const { Host } = makeEditorHost({ initial: framed })
  const { container } = render(<Host />)

  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByRole('menuitem', { name: 'Edit label' })).toBeInTheDocument()
})

it('a double-click on an edge inside a frame opens its label editor', async () => {
  const { Host } = makeEditorHost({ initial: framed })
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: edgeMidpoint(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-label-editor"]')).not.toBeNull(),
  )
})

it('a click on the frame border still selects the frame', async () => {
  const { Host } = makeEditorHost({ initial: framed })
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: { x: 41, y: 200 } })
  await vi.waitFor(() => expect(nodeSelection(container)).not.toBeNull())
  expect(edgeHighlight(container)).toBeNull()
})
