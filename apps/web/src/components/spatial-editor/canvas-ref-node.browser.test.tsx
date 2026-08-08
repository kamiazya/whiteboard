// File nodes as canvas references (embed spec J5a): created from the
// palette's canvas picker, followed via double press or the context menu,
// retargeted via "Change target". The reference string is opaque to the
// editor — the host page owns its meaning.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const OPTIONS = [
  { file: 'canvas-a', label: 'Release plan' },
  { file: 'canvas-b', label: 'Meeting notes' },
] as const

const withFileNode: SpatialCanvas = {
  nodes: [{ id: 'f1', type: 'file', x: 100, y: 100, width: 200, height: 60, file: 'canvas-a' }],
  edges: [],
}

function makeHost(initial: SpatialCanvas, onOpen?: (file: string, subpath?: string) => void) {
  const latest: { canvas: SpatialCanvas; commands: string[] } = { canvas: initial, commands: [] }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
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
          fileRefOptions={OPTIONS}
          onOpenFileRef={onOpen}
        />
      </div>
    )
  }
  return { Host, latest }
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

it('Add canvas opens the picker and picking creates a file node with that reference', async () => {
  const { Host, latest } = makeHost({ nodes: [], edges: [] })
  const { container } = render(<Host />)

  fireEvent.click(container.querySelector('[data-testid="add-canvas-button"]') as HTMLElement)
  await expect.element(page.getByTestId('canvas-picker-dialog')).toBeInTheDocument()

  const option = [
    ...container.querySelectorAll('[data-testid="canvas-picker-dialog"] button'),
  ].find((b) => b.textContent === 'Meeting notes') as HTMLButtonElement
  fireEvent.click(option)

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(latest.canvas.nodes[0]).toMatchObject({ type: 'file', file: 'canvas-b' })
  expect(latest.commands).toContain('create-node')
  expect(container.querySelector('[data-testid="canvas-picker-dialog"]')).toBeNull()
  // The card shows the RESOLVED label, not the opaque reference — the
  // stored value stays the reference, display goes through the resolver.
  await vi.waitFor(() => expect(container.textContent).toContain('Meeting notes'))
  expect(container.textContent).not.toContain('canvas-b')
})

it('a real double-click on a file node follows the reference', async () => {
  const opened: string[] = []
  const { Host } = makeHost(withFileNode, (file) => opened.push(file))
  const { container } = render(<Host />)

  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 130 } })
  await vi.waitFor(() => expect(opened).toEqual(['canvas-a']))
})

it('the file context menu offers Open canvas and Change target retargets via the picker', async () => {
  const opened: string[] = []
  const { Host, latest } = makeHost(withFileNode, (file) => opened.push(file))
  const { container } = render(<Host />)

  rightClick(rootOf(container), 200, 130)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(container.textContent).toContain('Open canvas')

  await userEvent.click(page.getByRole('menuitem', { name: 'Change target' }))
  await expect.element(page.getByTestId('canvas-picker-dialog')).toBeInTheDocument()

  // The current reference is marked in the list.
  const current = [
    ...container.querySelectorAll('[data-testid="canvas-picker-dialog"] [aria-current="true"]'),
  ]
  expect(current.map((b) => b.textContent)).toEqual(['Release plan'])

  const target = [
    ...container.querySelectorAll('[data-testid="canvas-picker-dialog"] button'),
  ].find((b) => b.textContent === 'Meeting notes') as HTMLButtonElement
  fireEvent.click(target)

  await vi.waitFor(() =>
    expect(latest.canvas.nodes[0]).toMatchObject({ type: 'file', file: 'canvas-b' }),
  )
  expect(latest.commands).toContain('set-node-file')
})

it('without host seams, neither the Add canvas button nor file follow-affordances appear', async () => {
  const bare: SpatialCanvas = withFileNode
  function BareHost() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(bare)
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor canvas={canvas} onChange={(next) => setCanvas(next)} theme="light" />
      </div>
    )
  }
  const { container } = render(<BareHost />)

  expect(container.querySelector('[data-testid="add-canvas-button"]')).toBeNull()

  rightClick(rootOf(container), 200, 130)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(container.textContent).not.toContain('Open canvas')
  expect(container.textContent).not.toContain('Change target')
})
