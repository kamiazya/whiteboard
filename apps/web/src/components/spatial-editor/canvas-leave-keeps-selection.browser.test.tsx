// Leaving the canvas without walking every node: F6 and Shift+F6 move focus
// to the controls after and before it, and the selection stays where it was,
// so a panel that follows the selection still shows the chosen node.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'First' }),
    textNode({ id: 'b', x: 300, y: 40, width: 120, height: 60, text: 'Second' }),
    textNode({ id: 'c', x: 40, y: 300, width: 120, height: 60, text: 'Third' }),
  ],
  edges: [],
}

function mount() {
  const host = makeEditorHost({ initial: board })
  const { container } = render(
    <>
      <button type="button">Before the canvas</button>
      <host.Host />
    </>,
  )
  rootOf(container).focus()
  return { ...host, container }
}

const selectedNames = () =>
  page
    .getByRole('option', { selected: true })
    .elements()
    .map((el) => el.getAttribute('aria-label'))

it('Shift+F6 moves focus before the canvas and keeps the selection', async () => {
  const { container } = mount()
  await userEvent.keyboard('{Tab}{Tab}')
  await vi.waitFor(() => expect(selectedNames()).toEqual(['Second']))
  await userEvent.keyboard('{Shift>}{F6}{/Shift}')
  await expect.element(page.getByRole('button', { name: 'Before the canvas' })).toHaveFocus()
  expect(selectedNames()).toEqual(['Second'])
  expect(rootOf(container).contains(document.activeElement)).toBe(false)
})

it('F6 moves focus on past the canvas and keeps the selection', async () => {
  const { container } = mount()
  await userEvent.keyboard('{Tab}{Tab}')
  await userEvent.keyboard('{F6}')
  await vi.waitFor(() => expect(document.activeElement === rootOf(container)).toBe(false))
  expect(document.activeElement === document.body).toBe(false)
  expect(selectedNames()).toEqual(['Second'])
})
