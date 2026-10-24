import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canvasAnnouncement } from '../../lib/canvas-announcer.js'
import { CanvasA11yTree } from './CanvasA11yTree.js'

afterEach(cleanup)

beforeEach(async () => {
  await vi.waitFor(() => expect(canvasAnnouncement()).toBe(''), { timeout: 4000 })
})

const empty: SpatialCanvas = { nodes: [], edges: [] }
const loaded: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'One' }),
    textNode({ id: 'b', x: 200, y: 0, width: 100, height: 50, text: 'Two' }),
  ],
  edges: [],
}

const tree = (canvas: SpatialCanvas, externalVersion: number) => (
  <CanvasA11yTree
    canvas={canvas}
    idPrefix="t"
    primaryId={null}
    extraIds={new Set()}
    selectedEdgeId={null}
    externalVersion={externalVersion}
  />
)

it('a document that arrives from outside is not announced as nodes the person added', () => {
  const view = render(tree(empty, 0))
  view.rerender(tree(loaded, 1))
  expect(canvasAnnouncement()).toBe('')
})

it('nodes added by the person are still announced', () => {
  const view = render(tree(empty, 0))
  view.rerender(tree(loaded, 0))
  expect(canvasAnnouncement()).toBe('2 nodes added')
})
