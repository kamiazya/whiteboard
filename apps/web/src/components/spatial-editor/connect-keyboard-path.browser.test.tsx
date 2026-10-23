// A live connect offers focusable attach targets; Tab from the canvas root
// must reach them before anything else, or the keyboard path to a target is
// unreachable in the real editor (the dock sits earlier in tab order).
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
    textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 400, y: 40, width: 120, height: 60, text: 'B' }),
  ],
  edges: [],
}

async function armConnect() {
  const host = makeEditorHost({ initial: board })
  const { container } = render(<host.Host />)
  rootOf(container).focus()
  await userEvent.keyboard('{Tab}')
  const handle = page.getByTestId('connect-handle').element() as HTMLElement
  handle.focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByTestId('connect-target-b')).toBeInTheDocument()
  rootOf(container).focus()
  return { ...host, container }
}

it('Tab from the canvas root while a connect is live lands on the first attach target', async () => {
  await armConnect()
  await userEvent.keyboard('{Tab}')
  expect(document.activeElement?.getAttribute('data-testid')).toBe('connect-target-b')
})

it('Enter on the reached target attaches', async () => {
  const { latest } = await armConnect()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(1))
})

it('Escape on the reached target cancels the gesture', async () => {
  const { container } = await armConnect()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="connect-target-b"]')).toBeNull(),
  )
})
