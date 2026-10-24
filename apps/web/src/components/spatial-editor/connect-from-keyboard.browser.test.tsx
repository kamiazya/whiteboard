// Connecting two notes with no pointer: select a node, C arms the connect,
// arrows choose the target (outlined and announced), Enter connects and Esc
// cancels.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { canvasAnnouncement } from '../../lib/canvas-announcer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'Draft' }),
    textNode({ id: 'b', x: 300, y: 40, width: 120, height: 60, text: 'Review' }),
    textNode({ id: 'c', x: 560, y: 40, width: 120, height: 60, text: 'Ship' }),
  ],
  edges: [],
}

const target = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="connect-target-${id}"]`)

async function armFromDraft() {
  const host = makeEditorHost({ initial: board })
  const { container } = render(<host.Host />)
  rootOf(container).focus()
  await userEvent.keyboard('{Tab}')
  await userEvent.keyboard('c')
  await vi.waitFor(() => expect(target(container, 'b')).not.toBeNull())
  return { ...host, container }
}

it('C on a selected node arms a connect from it instead of switching tool', async () => {
  const { container } = await armFromDraft()
  expect(container.querySelector('[data-testid="connect-source-indicator"]')).not.toBeNull()
  expect(
    container.querySelector('[data-testid="select-tool-button"]')?.getAttribute('aria-pressed'),
  ).toBe('true')
  expect(canvasAnnouncement()).toContain('Draft')
})

it('arrows outline and announce each target, and Enter connects to the one chosen', async () => {
  const { container, latest } = await armFromDraft()
  await userEvent.keyboard('{ArrowRight}')
  expect(target(container, 'b')?.getAttribute('data-focused')).toBe('true')
  expect(canvasAnnouncement()).toBe("Connect to 'Review'")
  await userEvent.keyboard('{ArrowRight}')
  expect(target(container, 'c')?.getAttribute('data-focused')).toBe('true')
  expect(canvasAnnouncement()).toBe("Connect to 'Ship'")
  await userEvent.keyboard('{ArrowLeft}')
  expect(target(container, 'b')?.getAttribute('data-focused')).toBe('true')
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(1))
  expect(latest.canvas.edges[0]).toMatchObject({ from: { node: 'a' }, to: { node: 'b' } })
  expect(latest.canvas.nodes.map((n) => n.x)).toEqual([40, 300, 560])
})

it('Escape cancels the connect and leaves the canvas as it was', async () => {
  const { container, latest } = await armFromDraft()
  await userEvent.keyboard('{ArrowRight}')
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(target(container, 'b')).toBeNull())
  expect(latest.canvas.edges).toHaveLength(0)
})

it('C with nothing selected still switches to the Connect tool', async () => {
  const host = makeEditorHost({ initial: board })
  const { container } = render(<host.Host />)
  rootOf(container).focus()
  await userEvent.keyboard('c')
  await expect
    .poll(() =>
      container.querySelector('[data-testid="connect-tool-button"]')?.getAttribute('aria-pressed'),
    )
    .toBe('true')
})
