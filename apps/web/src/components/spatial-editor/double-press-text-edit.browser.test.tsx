// Regression: double-click text editing must survive REAL pointer sequences.
// The first press selects the node and re-renders the DOM under the pointer
// (selection overlay, gesture state), so the browser can see the two clicks
// landing on different element instances and never synthesise a `dblclick`
// at all — double-click-to-edit silently did nothing in the running app
// while synthetic-event tests stayed green. The editor therefore detects a
// double press itself, by node id and time window, which is stable against
// re-renders. These tests drive real pointer input end to end.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello world' }],
  edges: [],
}

function Host({ onCommand }: { onCommand?: (kind: string) => void }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
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

it('a real double-click on a text node opens its editor with the existing text', async () => {
  const { container } = render(<Host />)
  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 150 } })

  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  expect(container.querySelector('textarea')?.value).toBe('hello world')
})

it('a real double-click on an already-selected node still opens the editor', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 200, y: 150 } })
  expect(container.querySelectorAll('[data-testid="selection-overlay"]').length).toBe(1)

  await userEvent.dblClick(root, { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
})

it('a real double-click on empty space creates exactly one node and opens it', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  await userEvent.dblClick(rootOf(container), { position: { x: 600, y: 450 } })

  expect(commands.filter((kind) => kind === 'create-node')).toHaveLength(1)
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
})

it('typing into the opened editor and committing persists the text', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  const root = rootOf(container)
  await userEvent.dblClick(root, { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  const textarea = container.querySelector('textarea')

  await userEvent.fill(textarea as HTMLTextAreaElement, 'edited body')
  // Click far outside the node to blur-commit.
  await userEvent.click(root, { position: { x: 700, y: 500 } })

  expect(commands).toContain('set-text')
  expect(container.querySelector('textarea')).toBeNull()
})
