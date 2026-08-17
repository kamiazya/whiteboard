// Regression: pressing "Note" with a REAL pointer sequence must create
// a node. The root gesture handler used to capture the pointer on the
// button's own pointerdown (it hit-tests as empty canvas space), and an
// active capture retargets the subsequent `click` to the capturing element —
// so the button's onClick never fired and the press silently did nothing.
// A synthetic MouseEvent('click') skips pointerdown entirely and cannot see
// this, which is why the older test missed it: only a real pointer sequence
// (userEvent) exercises the capture path.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

function Host({ onCommand }: { onCommand: (kind: string) => void }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>({ nodes: [], edges: [] })
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={(next, command) => {
          onCommand(command.kind)
          setCanvas(next)
        }}
        theme="light"
      />
    </div>
  )
}

it('a real pointer click on "Note" creates a node and opens its editor', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)

  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Note' }))

  expect(commands).toEqual(['create-node'])
  expect(container.querySelectorAll('svg rect').length).toBeGreaterThan(0)
  expect(container.querySelectorAll('textarea').length).toBe(1)
})

it('committing the new note untouched keeps a visible empty node, not a blank canvas', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)

  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Note' }))
  // Click empty canvas space without typing — the editor commits the (empty)
  // pending text and the node must survive as a visible box.
  await userEvent.click(container.querySelector('[data-testid="spatial-editor"]') as Element, {
    // A far corner: the new note (and its editor) sit at the viewport
    // centre, and clicking INSIDE the open textarea correctly keeps the
    // editor open — the commit only happens when the press lands outside.
    position: { x: 770, y: 570 },
  })

  expect(commands[0]).toBe('create-node')
  expect(container.querySelectorAll('textarea').length).toBe(0)
  expect(container.querySelectorAll('svg rect').length).toBeGreaterThan(0)
})
