// A stroke's ENDS, from the ink menu: the arrowheads it is drawn with, and
// which side of a box an attached end leaves from.
//
// `lineEndSchema` carries `end` and `side` exactly as `edgeEndSchema` does —
// so a stroke could store both and the editor wrote neither. The rows are the
// relation menu's OWN, shared rather than copied, which is what keeps a
// five-way picker from growing a sixth on one of them.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const attached: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'note' })],
  edges: [],
  lines: [
    {
      id: 'l1',
      from: { kind: 'node', node: 'a' },
      to: { kind: 'point', point: { x: 500, y: 400 } },
    },
  ],
}

const free: SpatialCanvas = {
  ...attached,
  lines: [
    {
      id: 'l1',
      from: { kind: 'point', point: { x: 200, y: 300 } },
      to: { kind: 'point', point: { x: 500, y: 300 } },
    },
  ],
}

function makeHost(start: SpatialCanvas) {
  const latest = { canvas: start }
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

async function openInkMenuAt(container: HTMLElement, at: { x: number; y: number }) {
  const root = rootOf(container)
  const rect = root.getBoundingClientRect()
  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: rect.left + at.x,
      clientY: rect.top + at.y,
    }),
  )
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
}

it('gives a stroke an arrowhead', async () => {
  const { Host, latest } = makeHost(free)
  const { container } = render(<Host />)

  await openInkMenuAt(container, { x: 350, y: 300 })
  await userEvent.click(await page.getByRole('menuitemradio', { name: 'Forward' }).element())

  await expect.poll(() => latest.canvas.lines?.[0]?.to.end).toBe('arrow')
  expect(latest.canvas.lines?.[0]?.from.end).toBe('none')
})

it('pins the side an attached end leaves the box from', async () => {
  const { Host, latest } = makeHost(attached)
  const { container } = render(<Host />)

  // Just short of the free end, where the last stretch runs whatever the
  // router did earlier.
  await openInkMenuAt(container, { x: 488, y: 388 })
  await userEvent.click(await page.getByRole('menuitemradio', { name: 'Top' }).element())

  await expect
    .poll(() => latest.canvas.lines?.[0]?.from)
    .toEqual({
      kind: 'node',
      node: 'a',
      side: 'top',
    })
})

it('offers no side row for a stroke that meets no box', async () => {
  // A free end has no side to pin, and five choices that write nothing is
  // worse than an absent row.
  const { Host } = makeHost(free)
  const { container } = render(<Host />)

  await openInkMenuAt(container, { x: 350, y: 300 })

  const menu = page.getByTestId('context-menu').element() as HTMLElement
  expect(menu.textContent).toContain('Arrows')
  expect(menu.textContent).not.toContain('From side')
  expect(menu.textContent).not.toContain('To side')
})
