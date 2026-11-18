/**
 * The live drag overlay reaches the Rust core (ADR-0054 step 7, S18d): every
 * pointer move re-lays the edges out through the core's query entry
 * (`edges`), and the frame titles the preview routes round come from it too
 * (`label-obstacles`), with the measurer the overlay memoises per gesture
 * named as the page's own, so every frame is a request the core is handed.
 *
 * This drives a real drag, with the core asked for an edge layer on every
 * move. The overlay's SVG is the core's too: each `edges` request asks for the
 * layer drawn in the overlay's envelope (its own bounds), and what the overlay
 * mounts is the picture the core answered, not one serialized on this side.
 */

import type {
  LayoutCore,
  QueryAnswer,
  QueryLayoutCore,
  QueryRequest,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { layoutCoreReady } from '../../lib/spatial/layout-core.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const loaded: LayoutCore | undefined = await layoutCoreReady()

it('loads the core before the overlay asks it', () => {
  expect(loaded?.query).toBeDefined()
})

const board: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'f', x: 40, y: 20, width: 760, height: 320, label: 'Request path' }),
    textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'Alpha' }),
    textNode({ id: 'b', x: 500, y: 100, width: 120, height: 60, text: 'Beta' }),
    textNode({ id: 'c', x: 300, y: 240, width: 120, height: 60, text: 'Gamma' }),
  ],
  edges: [
    { id: 'ab', from: { node: 'a' }, to: { node: 'b', end: 'arrow' }, label: 'calls' },
    { id: 'bc', from: { node: 'b' }, to: { node: 'c', end: 'arrow' } },
  ],
}

const frame = () => new Promise((r) => requestAnimationFrame(r))

it('lays the drag overlay out through the core on every move', async () => {
  const query = (loaded as LayoutCore).query as QueryLayoutCore
  const asked = vi.spyOn(query, 'layoutQuery')
  try {
    const { Host } = makeEditorHost({ initial: board, size: { width: 900, height: 700 } })
    const { container } = render(<Host />)
    const root = rootOf(container)
    const r = root.getBoundingClientRect()
    const at = (x: number, y: number) => ({
      pointerId: 7,
      clientX: r.left + x,
      clientY: r.top + y,
      buttons: 1,
    })
    fireEvent.pointerDown(root, at(160, 130))
    await frame()
    for (const [x, y] of [
      [190, 150],
      [220, 200],
      [260, 280],
    ] as const) {
      fireEvent.pointerMove(root, at(x, y))
      await frame()
    }
    await expect
      .poll(() => container.querySelector('[data-testid="live-edges"] polyline'))
      .not.toBeNull()
    const kinds = asked.mock.calls.map(([request]) => (request as QueryRequest).query)
    expect(kinds.filter((kind) => kind === 'edges').length).toBeGreaterThanOrEqual(3)
    expect(kinds).toContain('label-obstacles')
  } finally {
    asked.mockRestore()
  }
})

it("mounts the edge layer's SVG the core drew in the same call", async () => {
  const query = (loaded as LayoutCore).query as QueryLayoutCore
  const original = query.layoutQuery.bind(query)
  const edges: { request: QueryRequest; answer: QueryAnswer }[] = []
  const asked = vi.spyOn(query, 'layoutQuery').mockImplementation((request, ...rest) => {
    const answer = original(request, ...rest)
    if (request.query === 'edges') edges.push({ request, answer })
    return answer
  })
  try {
    const { Host } = makeEditorHost({ initial: board, size: { width: 900, height: 700 } })
    const { container } = render(<Host />)
    const root = rootOf(container)
    const r = root.getBoundingClientRect()
    const at = (x: number, y: number) => ({
      pointerId: 7,
      clientX: r.left + x,
      clientY: r.top + y,
      buttons: 1,
    })
    fireEvent.pointerDown(root, at(160, 130))
    await frame()
    for (const [x, y] of [
      [190, 150],
      [240, 230],
    ] as const) {
      fireEvent.pointerMove(root, at(x, y))
      await frame()
    }
    const overlay = () => container.querySelector('[data-testid="live-edges"]')
    await expect.poll(() => overlay()?.querySelector('polyline')).not.toBeNull()
    expect(edges.length).toBeGreaterThan(0)
    for (const { request } of edges) {
      expect(request).toMatchObject({ svg: { viewBox: { of: 'scene' } } })
    }
    const last = edges.at(-1)?.answer
    const drawn = last !== undefined && 'svg' in last ? last.svg : undefined
    expect(drawn).toBeTypeOf('string')
    // The DOM's own serialization of the core's markup, as the overlay's.
    const expected = document.createElement('div')
    expected.innerHTML = drawn ?? ''
    expect(overlay()?.innerHTML).toBe(expected.innerHTML)
  } finally {
    asked.mockRestore()
  }
})
