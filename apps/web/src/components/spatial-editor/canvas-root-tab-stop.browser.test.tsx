// A returning keyboard user must be able to reach the canvas and start
// walking its nodes: the root is a Tab stop that says what it holds and how
// to begin, and the walk still works after notes were made by keyboard.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
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

function mountAfterButton(initial: SpatialCanvas) {
  const host = makeEditorHost({ initial })
  const { container } = render(
    <>
      <button type="button" data-testid="before">
        before
      </button>
      <host.Host />
    </>,
  )
  return { ...host, container }
}

async function movedByNudge(latest: { canvas: SpatialCanvas }): Promise<string | undefined> {
  const before = latest.canvas
  await userEvent.keyboard('{ArrowDown}')
  const moved = latest.canvas.nodes.find(
    (n) => n.y !== (before.nodes.find((b) => b.id === n.id)?.y ?? n.y),
  )
  await userEvent.keyboard('{ArrowUp}')
  return moved?.id
}

it('Tab from the control before the editor reaches the canvas, named with its count and how to start', async () => {
  const { container } = mountAfterButton(board)
  ;(container.querySelector('[data-testid="before"]') as HTMLElement).focus()
  await userEvent.keyboard('{Tab}')
  expect(document.activeElement).toBe(rootOf(container))
  expect(rootOf(container).getAttribute('aria-label')).toBe(
    'Canvas, 2 notes. Tab selects the first note',
  )
})

it('an empty canvas is named without a walk it cannot offer', async () => {
  const { container } = mountAfterButton({ nodes: [], edges: [] })
  expect(rootOf(container).getAttribute('aria-label')).toBe('Canvas, empty')
})

it('Tab after making two notes by keyboard and pressing Escape selects the first note', async () => {
  const { container, latest } = mountAfterButton({ nodes: [], edges: [] })
  rootOf(container).focus()
  for (const text of ['one', 'two']) {
    await userEvent.keyboard('n')
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="text-node-editor"]')).toBeTruthy(),
    )
    await userEvent.keyboard(text)
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="text-node-editor"]')).toBeNull(),
    )
  }
  await userEvent.keyboard('{Escape}')
  await userEvent.keyboard('{Tab}')
  expect(document.activeElement).toBe(rootOf(container))
  expect(latest.canvas.nodes).toHaveLength(2)
  const first = latest.canvas.nodes[0]?.id
  expect(await movedByNudge(latest)).toBe(first)
})
