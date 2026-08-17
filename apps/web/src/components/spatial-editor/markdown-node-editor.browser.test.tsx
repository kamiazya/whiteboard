// The node text editor speaks the same markdown as the document editor:
// CodeMirror with the GFM grammar, the same highlight classes, the same
// list continuation and Mod-b/i/e wraps. What stays node-shaped is the
// exit semantics: ⌘Enter COMMITS (the overlay's most important verb — it
// deliberately outranks the document editor's task-toggle binding), and
// losing focus commits too, so nothing typed is ever lost.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

function makeHost(text: string) {
  const start: SpatialCanvas = {
    nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 260, height: 120, text }],
    edges: [],
  }
  const latest: { canvas: SpatialCanvas } = { canvas: start }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

function openEditor(container: HTMLElement) {
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const at = { clientX: r.left + 200, clientY: r.top + 150 }
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, ...at })
  fireEvent.pointerUp(root, { pointerId: 1, ...at })
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, ...at })
  fireEvent.pointerUp(root, { pointerId: 1, ...at })
}

it('the node editor is CodeMirror with markdown highlighting — same grammar as the document editor', async () => {
  const { Host } = makeHost('plain **bold** text')
  const { container } = render(<Host />)
  openEditor(container)

  await vi.waitFor(() => {
    const editor = container.querySelector('[data-testid="text-node-editor"]')
    expect(editor).not.toBeNull()
    expect(editor?.querySelector('.cm-editor')).not.toBeNull()
  })
  // The **bold** span carries a highlight class from the shared style —
  // typing markdown VISIBLY means something while editing.
  const styled = container.querySelector('[data-testid="text-node-editor"] [class*="cm-md-"]')
  expect(styled).not.toBeNull()
})

it('⌘Enter COMMITS — it does not toggle a task checkbox inside a node', async () => {
  const { Host, latest } = makeHost('- [ ] todo item')
  const { container } = render(<Host />)
  openEditor(container)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"]')).not.toBeNull(),
  )

  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"]')).toBeNull(),
  )
  const node = latest.canvas.nodes[0]
  expect(node?.type === 'text' ? node.text : undefined).toBe('- [ ] todo item')
})

it('losing focus commits what was typed — nothing is ever lost to a stray click', async () => {
  const { Host, latest } = makeHost('start')
  const { container } = render(<Host />)
  openEditor(container)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"] .cm-content')).not.toBeNull(),
  )

  await userEvent.keyboard(' typed')
  const content = container.querySelector(
    '[data-testid="text-node-editor"] .cm-content',
  ) as HTMLElement
  fireEvent.blur(content)

  await vi.waitFor(() => {
    const node = latest.canvas.nodes[0]
    expect(node?.type === 'text' ? node.text : undefined).toBe('start typed')
  })
})

it('Enter continues a list item, and Enter on an empty item exits the list', async () => {
  const { Host, latest } = makeHost('- alpha')
  const { container } = render(<Host />)
  openEditor(container)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="text-node-editor"] .cm-content')).not.toBeNull(),
  )

  await userEvent.keyboard('{Enter}beta{Enter}{Enter}done')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')

  await vi.waitFor(() => {
    const node = latest.canvas.nodes[0]
    expect(node?.type === 'text' ? node.text : undefined).toBe('- alpha\n- beta\ndone')
  })
})
