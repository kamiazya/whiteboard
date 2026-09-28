// A proposal's bubble is chrome above the board, answered at the release:
// a press that stays put toggles the card, one that travels was a pan and
// opens nothing, and a press anywhere else on the surface shuts an open card
// — the one dismissal a phone has.

import type { Proposal, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 120, height: 60, text: 'the plan' })],
  edges: [],
}

const proposal: Proposal = {
  id: 'p1',
  changes: [
    {
      id: 'node:n1',
      op: 'node.patch',
      status: 'open',
      nodeId: 'n1',
      patch: { x: 400 },
      assumed: { x: 0 },
    },
  ],
}

async function mount() {
  const { container } = render(
    <div style={{ width: 900, height: 700 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        proposals={[proposal]}
        onChange={() => {}}
        theme="light"
      />
    </div>,
  )
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await vi.waitFor(() =>
    expect(root.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'proposed change',
    ),
  )
  return root
}

/** The bubble's centre, found by the words it draws rather than a guessed viewport. */
function bubbleCentre(root: HTMLElement) {
  const content = root.querySelector('[data-testid="canvas-content"]') as SVGElement
  const text = [...content.querySelectorAll('text')].find((el) =>
    el.textContent?.includes('proposed change'),
  ) as SVGTextElement
  const r = text.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

function press(root: HTMLElement, pointerId: number, from: { x: number; y: number }, to = from) {
  fireEvent.pointerDown(root, { button: 0, pointerId, clientX: from.x, clientY: from.y })
  fireEvent.pointerUp(root, { pointerId, clientX: to.x, clientY: to.y })
}

const card = () => document.querySelector('[data-testid="proposal-card"]')

it('a press on the bubble that travels opens no card; one that stays put does', async () => {
  const root = await mount()
  const at = bubbleCentre(root)

  press(root, 1, at, { x: at.x + 40, y: at.y + 30 })
  // The card toggles at the release, synchronously under fireEvent's act
  // flush, so absent now is absent for good.
  expect(card()).toBeNull()

  press(root, 2, at)
  await vi.waitFor(() => expect(card()).not.toBeNull())
})

it('a press elsewhere on the surface shuts the open card', async () => {
  const root = await mount()
  press(root, 1, bubbleCentre(root))
  await vi.waitFor(() => expect(card()).not.toBeNull())

  const r = root.getBoundingClientRect()
  press(root, 2, { x: r.right - 20, y: r.bottom - 20 })
  await vi.waitFor(() => expect(card()).toBeNull())
})
