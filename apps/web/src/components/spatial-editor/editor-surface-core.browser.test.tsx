/**
 * The editor surface's picture is the Rust core's (ADR-0054 A3.3): the layout
 * the editor asks for carries the keyed envelope, and the core answers the
 * keyed projection in the same call. What the editor mounts is that answer —
 * the main thread never serializes the scene on this side.
 */

import type {
  CanvasLayoutCore,
  CanvasLayoutRequest,
  KeyedSvgRender,
  LayoutCore,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { layoutCoreReady } from '../../lib/spatial/layout-core.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const loaded: LayoutCore | undefined = await layoutCoreReady()

it('loads the core before the editor asks it', () => {
  expect(loaded?.layout).toBeDefined()
})

const board: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'f', x: 40, y: 20, width: 760, height: 320, label: 'Request path' }),
    textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'Alpha' }),
    textNode({ id: 'b', x: 500, y: 100, width: 120, height: 60, text: 'Beta' }),
  ],
  edges: [{ id: 'ab', from: { node: 'a' }, to: { node: 'b', end: 'arrow' }, label: 'calls' }],
}

it('mounts the keyed projection the core drew in the layout call', async () => {
  const layout = (loaded as LayoutCore).layout as CanvasLayoutCore
  const original = layout.layoutSpatialCanvas.bind(layout)
  const asked: { request: CanvasLayoutRequest; keyed?: KeyedSvgRender }[] = []
  const spy = vi.spyOn(layout, 'layoutSpatialCanvas').mockImplementation((request, ...rest) => {
    const answer = original(request, ...rest)
    asked.push({
      request,
      ...('keyed' in answer && answer.keyed !== undefined ? { keyed: answer.keyed } : {}),
    })
    return answer
  })
  try {
    const { Host } = makeEditorHost({ initial: board, size: { width: 900, height: 700 } })
    const { container } = render(<Host />)
    rootOf(container)
    // Every layout of the board's committed surface asked for the keyed projection.
    const ids = (request: CanvasLayoutRequest) => request.canvas.nodes.map((node) => node.id)
    const surface = asked.filter(({ request }) => ids(request).join() === 'f,a,b')
    expect(surface.length).toBeGreaterThan(0)
    for (const { request } of surface) {
      expect(request.svg).toEqual({ viewBox: { of: 'scene' }, legend: 'omit', form: 'keyed' })
    }
    const drawn = surface.at(-1)?.keyed
    expect(drawn?.groups.length).toBeGreaterThan(0)
    // The DOM's own serialization of the core's markup, as the surface's.
    const expected = document.createElement('div')
    expected.innerHTML = drawn?.svg ?? ''
    const content = () => container.querySelector('[data-testid="canvas-content"]')
    await expect.poll(() => content()?.innerHTML ?? null).toBe(expected.innerHTML)
  } finally {
    spy.mockRestore()
  }
})
