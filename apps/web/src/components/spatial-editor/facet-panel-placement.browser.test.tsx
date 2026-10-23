// The Facets panel takes a column out of the canvas, so a node that sat in
// that column would be styled blind: the panel opens over the very box it is
// about. Opening it keeps the selection in the part of the canvas that is
// left.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const canvasWith = (x: number): SpatialCanvas => ({
  nodes: [textNode({ id: 'a', x, y: 80, width: 200, height: 100, text: 'A' })],
  edges: [],
})

function openFacetsOnNodeAt(x: number) {
  const { Host } = makeEditorHost({ initial: canvasWith(x) })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const nodeRect = () =>
    (container.querySelector('svg g[data-wb-key="a"]') as SVGGElement).getBoundingClientRect()
  const before = nodeRect()
  fireEvent.contextMenu(root, { clientX: r.left + before.x + 20, clientY: r.top + before.y + 20 })
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  const entry = [...menu.querySelectorAll('button')].find((b) => b.textContent?.includes('Facets'))
  fireEvent.click(entry as HTMLElement)
  const panel = container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
  return { before, nodeRect, panelRect: panel.getBoundingClientRect() }
}

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

it('opening Facets on a node under the panel moves it into the visible canvas', async () => {
  const { nodeRect, panelRect } = openFacetsOnNodeAt(620)
  await expect.poll(() => overlaps(nodeRect(), panelRect)).toBe(false)
  expect(nodeRect().right).toBeLessThanOrEqual(panelRect.left)
})

it('opening Facets leaves a node that is already clear of the panel where it was', async () => {
  const { before, nodeRect, panelRect } = openFacetsOnNodeAt(80)
  expect(overlaps(before, panelRect)).toBe(false)
  await expect.poll(() => nodeRect().left).toBe(before.left)
})

it('closing the panel does not slide the board back', async () => {
  const { nodeRect, panelRect } = openFacetsOnNodeAt(620)
  await expect.poll(() => overlaps(nodeRect(), panelRect)).toBe(false)
  const moved = nodeRect()
  const root = rootOf(document.body)
  fireEvent.pointerDown(root, { clientX: 20, clientY: 400, button: 0, pointerId: 7 })
  fireEvent.pointerUp(root, { clientX: 20, clientY: 400, button: 0, pointerId: 7 })
  await expect.poll(() => document.querySelector('[data-testid="facet-form-panel"]')).toBeNull()
  expect(nodeRect().left).toBe(moved.left)
})
