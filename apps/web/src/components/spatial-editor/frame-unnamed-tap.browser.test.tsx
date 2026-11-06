// A frame left unnamed (Escape in its name field) is still selected by a tap
// on its empty interior, the way a named one is — the documented model: a
// drag from the interior sweeps a band, a tap there selects the frame.

import { isFrame } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const selectedOptions = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="option"][aria-selected="true"]')].map((el) => el.id)

it('a tap inside a frame left unnamed with Escape selects the frame', async () => {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Frame' }))
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="group-label-editor"]'),
    ),
  )
  await userEvent.keyboard('{Escape}')
  const frame = latest.canvas.nodes.find(isFrame)
  if (frame === undefined) throw new Error('no frame was created')

  const root = rootOf(container)
  // Away from the frame first, so the tap below has something to change.
  await userEvent.click(root, { position: { x: 5, y: 5 } })
  await vi.waitFor(() => expect(selectedOptions(container)).toEqual([]))

  const box = container
    .querySelector(`[data-testid="canvas-content"] [data-wb-key="${frame.id}"]`)
    ?.getBoundingClientRect()
  const rootBox = root.getBoundingClientRect()
  expect(box).toBeTruthy()
  if (box === undefined) return
  await userEvent.click(root, {
    position: {
      x: box.left - rootBox.left + box.width / 2,
      y: box.top - rootBox.top + box.height / 2,
    },
  })
  await vi.waitFor(() =>
    expect(selectedOptions(container)).toEqual([
      expect.stringMatching(new RegExp(`-node-${frame.id}$`)),
    ]),
  )
})
