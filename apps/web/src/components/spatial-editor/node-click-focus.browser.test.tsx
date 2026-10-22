// A press on a node must leave the editor root focused: node shapes carry no
// tabIndex of their own, so without it Delete, nudges and every other
// selection shortcut land on <body> after a mouse click.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 40, y: 40, width: 160, height: 80, text: 'A' })],
  edges: [],
}

/** Root-relative centre of the first drawn node, in the click's own scaled space. */
function nodeCentre(container: HTMLElement) {
  const root = rootOf(container).getBoundingClientRect()
  const rect = container.querySelector('svg rect')!.getBoundingClientRect()
  return { x: rect.x + rect.width / 2 - root.x, y: rect.y + rect.height / 2 - root.y }
}

it('a click on a node focuses the editor root so Delete removes it', async () => {
  const { Host, latest } = makeEditorHost({ initial })
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: nodeCentre(container) })

  expect(document.activeElement).toBe(container.querySelector('[role="application"]'))
  await userEvent.keyboard('{Delete}')
  expect(latest.kinds).toContain('delete-node')
})

it('arrow keys nudge a node right after it was clicked', async () => {
  const { Host, latest } = makeEditorHost({ initial })
  const { container } = render(<Host />)
  await userEvent.click(rootOf(container), { position: nodeCentre(container) })
  await userEvent.keyboard('{ArrowRight}')

  expect(latest.canvas.nodes.find((n) => n.id === 'a')?.x).toBeGreaterThan(40)
})

it('a double click leaves focus in the in-place editor', async () => {
  const { Host } = makeEditorHost({ initial })
  const { container } = render(<Host />)
  await userEvent.dblClick(rootOf(container), { position: nodeCentre(container) })

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"]')).toBeTruthy(),
  )
  const editor = container.querySelector('[data-testid="text-node-editor"]')!
  await vi.waitFor(() => expect(editor.contains(document.activeElement)).toBe(true))
})

it('a click on a locked node does not pull focus out of an open editor', async () => {
  const two: SpatialCanvas = {
    nodes: [
      ...initial.nodes,
      textNode({ id: 'b', x: 400, y: 300, width: 120, height: 60, text: 'B' }),
    ],
    edges: [],
  }
  const { Host } = makeEditorHost({ initial: two, lockedNodes: ['b'] })
  const { container } = render(<Host />)
  await userEvent.dblClick(rootOf(container), { position: nodeCentre(container) })
  const editor = await vi.waitFor(() => {
    const el = container.querySelector('[data-testid="text-node-editor"]')
    expect(el).toBeTruthy()
    return el!
  })
  await vi.waitFor(() => expect(editor.contains(document.activeElement)).toBe(true))

  // Pressing inside the open editor is the "something else holds focus" case.
  await userEvent.click(editor.querySelector('textarea, [contenteditable], .cm-content')!)
  expect(editor.contains(document.activeElement)).toBe(true)
})
