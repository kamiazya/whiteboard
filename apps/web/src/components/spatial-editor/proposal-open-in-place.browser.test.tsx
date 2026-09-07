// ADR-0029 decision 1: never send a person elsewhere to see what changed.
//
// The Proposals panel is an INDEX, not a second place to decide — so a row
// press has to land the reader on the card that is already drawn on the
// board. That is one seam (`SpatialEditorHandle.openProposal`) doing two
// things a page cannot do from outside: move the viewport onto the chrome,
// and open the card that sits there.
import type { Proposal, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { SpatialEditorHandle } from '../../lib/spatial/editor-handle.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// Far enough from the origin that a viewport fitted to the whole canvas
// cannot have the chrome centred by accident — the pan has to be real.
const start: SpatialCanvas = {
  nodes: [
    { id: 'near', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'here' },
    { id: 'far', type: 'text', x: 4000, y: 3000, width: 120, height: 60, text: 'over there' },
  ],
  edges: [],
}

const proposal: Proposal = {
  id: 'p-far',
  changes: [
    {
      id: 'node:far',
      op: 'node.patch',
      status: 'open',
      nodeId: 'far',
      patch: { x: 4400 },
      assumed: { x: 4000 },
    },
  ],
}

function makeHost() {
  const handle: { current: SpatialEditorHandle | null } = { current: null }
  function Host() {
    const ref = useRef<SpatialEditorHandle | null>(null)
    handle.current = ref.current
    return (
      <div style={{ width: 900, height: 700 }}>
        <SpatialEditor
          ref={(node) => {
            ref.current = node
            handle.current = node
          }}
          defaultTool="select"
          canvas={start}
          proposals={[proposal]}
          onChange={() => {}}
          theme="light"
        />
      </div>
    )
  }
  return { Host, handle }
}

/**
 * Where the far node is drawn RIGHT NOW. Re-queried every time: the pan
 * re-renders the scene, and a node reference held across it reads the
 * position it had when it was detached.
 */
function farNodeLeft(root: HTMLElement): number {
  const el = root.querySelector('[data-testid="canvas-content"] [data-wb-key="far"]') as SVGGElement
  return el.getBoundingClientRect().left
}

it('opens a proposal where it sits, and answers whether it could', async () => {
  const { Host, handle } = makeHost()
  const { container } = render(<Host />)
  await expect.element(page.getByTestId('canvas-content')).toBeInTheDocument()
  expect(container.querySelector('[data-testid="proposal-card"]')).toBeNull()
  const framedOnLoad = farNodeLeft(container)

  expect(handle.current?.openProposal('p-far')).toBe(true)

  // Both halves of decision 1, and neither alone is the behaviour: the
  // board moved onto the chrome, AND the card drawn there is now open.
  await expect.element(page.getByTestId('proposal-card')).toBeInTheDocument()
  await vi.waitFor(() => expect(farNodeLeft(container)).not.toBe(framedOnLoad))
})

// The guard, not a signal: a panel's list can outrun the scene by a frame,
// and the answer is what stops the viewport being moved to nowhere while it
// catches up. So the caller's job is to do nothing, and this pins that
// nothing is what happens.
it('answers false for a proposal the canvas draws no chrome for', async () => {
  const { Host, handle } = makeHost()
  const { container } = render(<Host />)
  await expect.element(page.getByTestId('canvas-content')).toBeInTheDocument()
  const framedOnLoad = farNodeLeft(container)

  expect(handle.current?.openProposal('p-nowhere')).toBe(false)

  expect(container.querySelector('[data-testid="proposal-card"]')).toBeNull()
  expect(farNodeLeft(container)).toBe(framedOnLoad)
})
