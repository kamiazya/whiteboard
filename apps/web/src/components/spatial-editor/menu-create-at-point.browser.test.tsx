// A node created from the empty-canvas context menu lands where the person
// right-clicked, not at the viewport's free spot: they already chose WHERE.
// The two creations that go through a dialog carry that point across it.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

// Far from the centre of the 800x600 surface, where the free spot would be.
const AT = { x: 620, y: 460 }

/** Where the created node is centred — the menu places a node ON the click. */
function centreOf(canvas: SpatialCanvas) {
  const node = canvas.nodes[0]
  if (node === undefined) throw new Error('no node was created')
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 }
}

function rightClickAt(root: HTMLElement) {
  const r = root.getBoundingClientRect()
  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + AT.x,
      clientY: r.top + AT.y,
      button: 2,
    }),
  )
}

it('a document picked from the empty-canvas menu lands at the right-click', async () => {
  const { Host, latest } = makeEditorHost({
    initial: { nodes: [], edges: [] },
    editorProps: { fileRefOptions: [{ file: 'doc-a', label: 'Release plan' }] },
  })
  const { container } = render(<Host />)
  rightClickAt(rootOf(container))
  await userEvent.click(page.getByRole('menuitem', { name: 'Document' }))
  await expect.element(page.getByTestId('document-picker-dialog')).toBeInTheDocument()
  fireEvent.click(
    [...container.querySelectorAll('[data-testid="document-picker-dialog"] button')].find(
      (b) => b.textContent === 'Release plan',
    ) as HTMLElement,
  )

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(centreOf(latest.canvas)).toEqual(AT)
})

it('a link submitted from the empty-canvas menu lands at the right-click', async () => {
  const { Host, latest } = makeEditorHost({
    initial: { nodes: [], edges: [] },
    editorProps: { fileRefOptions: [{ file: 'doc-a', label: 'Release plan' }] },
  })
  const { container } = render(<Host />)
  rightClickAt(rootOf(container))
  await userEvent.click(page.getByRole('menuitem', { name: 'Link' }))
  await expect.element(page.getByTestId('link-url-dialog')).toBeInTheDocument()
  const input = container.querySelector('[data-testid="link-url-dialog"] input') as HTMLInputElement
  await userEvent.fill(input, 'https://jsoncanvas.org/')
  fireEvent.click(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'OK') as HTMLElement,
  )

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(centreOf(latest.canvas)).toEqual(AT)
})
