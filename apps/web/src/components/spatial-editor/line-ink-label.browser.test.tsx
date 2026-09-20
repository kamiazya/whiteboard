// Naming a stroke, the two ways in.
//
// The RENDERER has drawn a line's label all along — `composeEdgeLabel` takes
// a relation or a line, because the two are routed together — so this was
// never a drawing gap. It was an editing one, and a quiet one: the press key
// a double press arms is `edge:<id>` for a stroke exactly as for a relation,
// so the gesture already reached the overlay, and the overlay looked the id
// up in `canvas.edges` and returned null. Nothing opened, and nothing said
// why.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'note' })],
  edges: [],
  lines: [
    {
      id: 'l1',
      from: { kind: 'point', point: { x: 200, y: 300 } },
      to: { kind: 'point', point: { x: 500, y: 300 } },
    },
  ],
}

function makeHost() {
  const latest = { canvas: board }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(board)
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

/** The stroke runs along y=300; the viewport is identity at rest. */
const ON_THE_STROKE = { x: 350, y: 300 }

it('a double press on a stroke opens its label editor', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  await userEvent.dblClick(root, { position: ON_THE_STROKE })

  // The editor is a textarea; `fill` then a click away is how the existing
  // edge-label case commits, and the commit is what this is about.
  const editor = await vi.waitFor(() => {
    const found = container.querySelector('[data-testid="edge-label-editor"]')
    expect(found).not.toBeNull()
    return found as HTMLTextAreaElement
  })
  await userEvent.fill(editor, 'north wall')
  await userEvent.click(root, { position: { x: 700, y: 550 } })

  await expect.poll(() => latest.canvas.lines?.[0]?.label).toBe('north wall')
  // The write went to the collection the id came from; nothing invented a
  // relation to hang the name on.
  expect(latest.canvas.edges).toEqual([])
})

it('the ink menu offers the same verb, for a device with no double press', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const rect = root.getBoundingClientRect()

  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: rect.left + ON_THE_STROKE.x,
      clientY: rect.top + ON_THE_STROKE.y,
    }),
  )

  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(await page.getByRole('menuitem', { name: 'Edit label' }).element())

  const editor = await vi.waitFor(() => {
    const found = container.querySelector('[data-testid="edge-label-editor"]')
    expect(found).not.toBeNull()
    return found as HTMLTextAreaElement
  })
  await userEvent.fill(editor, 'south')
  await userEvent.click(root, { position: { x: 700, y: 550 } })

  await expect.poll(() => latest.canvas.lines?.[0]?.label).toBe('south')
})
