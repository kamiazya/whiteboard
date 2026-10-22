// The keyboard path through a connect: each target is named by what the node
// says, and the one holding focus is outlined on ITS OWN box — not on the box
// the connect started from.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { indexNodeBoxes } from '../../lib/spatial/geometry.js'
import { BoxTargetOverlay } from './BoxTargetOverlay.js'

afterEach(cleanup)

const canvas = {
  nodes: [
    textNode({ id: 'first-id', x: 10, y: 10, width: 120, height: 60, text: 'First box' }),
    textNode({ id: 'second-id', x: 300, y: 40, width: 140, height: 80, text: 'Second box' }),
  ],
  edges: [],
}
const boxes = indexNodeBoxes(canvas)

function mount() {
  return render(
    <svg aria-label="board">
      <BoxTargetOverlay
        gestureState={{ kind: 'connecting', fromNodeId: 'first-id' }}
        sourceNodeId="first-id"
        canvas={canvas}
        boxes={boxes}
        selectableBoxes={boxes}
        applyResult={() => {}}
      />
    </svg>,
  )
}

const geometry = (el: Element) =>
  ['x', 'y', 'width', 'height'].map((a) => Number(el.getAttribute(a)))

it('names the attach target by its text, not by its id', () => {
  const { container } = mount()
  const target = container.querySelector('[data-testid="connect-target-second-id"]')!
  expect(target.getAttribute('aria-label')).toBe("Attach to 'Second box'")
})

it('outlines the focused target on its own box and leaves the source marker on the source', async () => {
  const { container } = mount()
  const target = container.querySelector('[data-testid="connect-target-second-id"]') as SVGElement
  target.focus()
  await vi.waitFor(() =>
    expect(container.querySelectorAll('[data-focused="true"]')).toHaveLength(1),
  )
  const outlined = container.querySelectorAll('[data-focused="true"]')
  expect(geometry(outlined[0] as Element)).toEqual([300, 40, 140, 80])
  expect(outlined[0]?.getAttribute('data-testid')).toBe('connect-target-second-id')
  expect(outlined[0]?.getAttribute('stroke')).toBe('var(--manipulation)')
  const source = container.querySelector('[data-testid="connect-source-indicator"]')!
  expect(geometry(source)).toEqual([8, 8, 124, 64])
})
