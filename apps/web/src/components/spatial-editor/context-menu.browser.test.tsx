// The OOUI object-action surface: right-click a node for its actions,
// right-click empty space to create "here". Real pointer input throughout —
// synthetic-event-only coverage is how this editor's first-touch bugs
// survived unnoticed.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
}

function Host({ onCommand }: { onCommand?: (kind: string) => void }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        canvas={canvas}
        onChange={(next, command) => {
          onCommand?.(command.kind)
          setCanvas(next)
        }}
        theme="light"
      />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function rightClick(el: HTMLElement, x: number, y: number) {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + x,
      clientY: r.top + y,
      button: 2,
    }),
  )
}

it('right-clicking a text node opens its action menu; Edit text opens the editor', async () => {
  const { container } = render(<Host />)
  rightClick(rootOf(container), 200, 150)

  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(page.getByRole('menuitem', { name: 'Edit text' }))

  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  expect(container.querySelector('[data-testid="context-menu"]')).toBeNull()
})

it('Delete from the menu removes the node and its edges', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  rightClick(rootOf(container), 200, 150)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Delete' }))

  expect(commands).toContain('delete-node')
  await vi.waitFor(() =>
    expect(container.querySelectorAll('svg rect[fill="#ffffff"]').length).toBe(0),
  )
})

it('right-clicking empty space offers creation at that point', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  rightClick(rootOf(container), 600, 450)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Add note here' }))

  expect(commands).toContain('create-node')
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
})

it('Escape closes the menu without acting', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  rightClick(rootOf(container), 200, 150)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.keyboard('{Escape}')

  await vi.waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())
  expect(commands).toHaveLength(0)
})

// --- Edge context menu: the object under the pointer gets ITS actions ---

const edgeStart: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 100, width: 120, height: 60, text: 'B' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', label: 'link' }],
}

function makeEdgeHost() {
  const latest: { canvas: SpatialCanvas; commands: string[] } = { canvas: edgeStart, commands: [] }
  function EdgeHost() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(edgeStart)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
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
  return { EdgeHost, latest }
}

function edgeMidpoint(container: HTMLElement): { x: number; y: number } {
  const root = rootOf(container)
  const polyline = container.querySelector(
    '[data-testid="spatial-editor"] svg polyline',
  ) as SVGPolylineElement
  const edgeRect = polyline.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  return {
    x: edgeRect.x + edgeRect.width / 2 - rootRect.x,
    y: edgeRect.y + edgeRect.height / 2 - rootRect.y,
  }
}

it('right-clicking an edge offers Edit label and Delete, not node creation', async () => {
  const { EdgeHost, latest } = makeEdgeHost()
  const { container } = render(<EdgeHost />)

  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(container.textContent).not.toContain('Add note here')

  await userEvent.click(page.getByRole('menuitem', { name: 'Edit label' }))
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-label-editor"]')).not.toBeNull(),
  )
  expect(
    (container.querySelector('[data-testid="edge-label-editor"]') as HTMLTextAreaElement).value,
  ).toBe('link')
  expect(latest.canvas.edges).toHaveLength(1)
})

it('Delete from the edge menu removes the edge and leaves the nodes', async () => {
  const { EdgeHost, latest } = makeEdgeHost()
  const { container } = render(<EdgeHost />)

  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Delete' }))

  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(0))
  expect(latest.commands).toContain('delete-edge')
  expect(latest.canvas.nodes).toHaveLength(2)
})
