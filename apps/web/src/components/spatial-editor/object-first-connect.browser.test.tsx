// OOUI Connect tool (S7/S9): with the Connect tool armed, connecting two
// nodes is click A, then click B — no drag, no keyboard, no handle hunting.
// The tool is additive: Select stays the default and double-click creation
// survives in every mode (S6 decisions, 2026-08-08).
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'
// Without the stylesheet every Tailwind `absolute` in the dock degrades to
// `static`, so the dock lands in document flow and any absolutely-positioned
// sibling shifts it into the scene — where it becomes unclickable. This file
// asserts on real click targets, so it needs real styles.
import '../../index.css'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 300, width: 120, height: 60, text: 'B' },
  ],
  edges: [],
}

function makeHost() {
  const latest: { canvas: SpatialCanvas; commands: string[] } = { canvas: start, commands: [] }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command.kind)
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function connectToolButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-testid="connect-tool-button"]') as HTMLButtonElement
}

it('Connect tool: click A then click B creates the edge', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(connectToolButton(container))
  expect(connectToolButton(container).getAttribute('aria-pressed')).toBe('true')

  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 160, y: 130 } }) // node A
  await userEvent.click(root, { position: { x: 460, y: 330 } }) // node B

  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(1))
  expect(latest.canvas.edges[0]).toMatchObject({ fromNode: 'a', toNode: 'b' })
  expect(latest.commands).toContain('connect-nodes')
})

it('the Select tool stays the default and node presses do not start a connect', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const selectButton = container.querySelector(
    '[data-testid="select-tool-button"]',
  ) as HTMLButtonElement
  expect(selectButton.getAttribute('aria-pressed')).toBe('true')

  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 160, y: 130 } })
  await userEvent.click(root, { position: { x: 460, y: 330 } })
  expect(latest.canvas.edges).toHaveLength(0)
})

it('double-click creation survives while the Connect tool is armed (S6-2)', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(connectToolButton(container))
  await userEvent.dblClick(rootOf(container), { position: { x: 650, y: 480 } })

  await vi.waitFor(() => expect(latest.commands).toContain('create-node'))
  expect(latest.canvas.nodes.length).toBe(3)
})

it('arming a connect shows the source indicator immediately, before any pointer move', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(connectToolButton(container))
  await userEvent.click(rootOf(container), { position: { x: 160, y: 130 } })

  // A still hand must still see that the connect armed: the source node
  // carries a visible indicator without waiting for the rubber-band line
  // (which only appears on pointermove).
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="connect-source-indicator"]')).not.toBeNull(),
  )
})
