// A locked node is not invisible to the pointer: it takes the press, so what
// lies beneath it (the frame around it) is not dragged, and the person is
// told why nothing moved.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const framed: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'frame', x: 40, y: 40, width: 500, height: 320, label: 'G' }),
    textNode({ id: 'locked', x: 200, y: 160, width: 160, height: 80, text: 'L' }),
  ],
  edges: [],
}

function drag(root: HTMLElement, from: { x: number; y: number }, by: number) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + from.x,
    clientY: r.top + from.y,
  })
  fireEvent.pointerMove(root, {
    pointerId: 1,
    clientX: r.left + from.x + by,
    clientY: r.top + from.y + by,
  })
  fireEvent.pointerUp(root, {
    pointerId: 1,
    clientX: r.left + from.x + by,
    clientY: r.top + from.y + by,
  })
}

it('dragging a locked note moves neither it nor the frame around it, and says it is locked', () => {
  const { Host, latest } = makeEditorHost({ initial: framed, lockedNodes: ['locked'] })
  const { container } = render(<Host />)

  drag(rootOf(container), { x: 280, y: 200 }, 90)

  const byId = (id: string) => latest.canvas.nodes.find((n) => n.id === id)
  expect(byId('frame')).toMatchObject({ x: 40, y: 40 })
  expect(byId('locked')).toMatchObject({ x: 200, y: 160 })
  expect(container.querySelector('[data-testid="locked-notice"]')?.textContent).toContain(
    'Locked — unlock from the menu',
  )
})

it('a plain click on a locked note stays quiet', () => {
  const { Host } = makeEditorHost({ initial: framed, lockedNodes: ['locked'] })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 280,
    clientY: r.top + 200,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 280, clientY: r.top + 200 })

  expect(container.querySelector('[data-testid="locked-notice"]')?.textContent ?? '').toBe('')
})

it('the frame interior beside a locked note still drags the frame', () => {
  const { Host, latest } = makeEditorHost({ initial: framed, lockedNodes: ['locked'] })
  const { container } = render(<Host />)

  drag(rootOf(container), { x: 60, y: 60 }, 50)

  expect(latest.canvas.nodes.find((n) => n.id === 'frame')).toMatchObject({ x: 90, y: 90 })
})
