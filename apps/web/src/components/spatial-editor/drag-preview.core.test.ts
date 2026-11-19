// @vitest-environment node

// The connect preview routes outside any layout, so it takes the Rust core
// (ADR-0054) itself: a gesture that drew another line than the core's would
// show a route the drop then replaces.

import type { LayoutCore, RoutingCore } from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import { computeDragPreview } from './drag-preview.js'

const boxes: readonly NodeBox[] = [{ id: 'n1', box: { x: 0, y: 0, width: 100, height: 50 } }]
const canvas = {
  nodes: [
    textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50, text: '' }),
    textNode({ id: 'n2', x: 400, y: 300, width: 100, height: 50, text: '' }),
  ],
  edges: [{ id: 'e1', from: { node: 'n1' }, to: { node: 'n2' } }],
}

/** A core that routes every edge along one fixed detour, recording what it was asked. */
function fixedCore() {
  const asked: number[] = []
  const detour = [
    { x: 100, y: 25 },
    { x: 100, y: 200 },
    { x: 300, y: 200 },
  ]
  const elsewhere = [
    { x: 0, y: 0 },
    { x: 9, y: 9 },
  ]
  const routing: RoutingCore = {
    routeLayout(_nodes, edges) {
      asked.push(edges.length)
      return {
        // The existing edges get another line, so drawing the wrong one shows.
        routes: edges.map((edge) => ({
          id: edge.id,
          kind: 'edge' as const,
          path: edge.id === '__connect-preview__' ? detour : elsewhere,
        })),
        anchors: new Map(),
      } as unknown as ReturnType<RoutingCore['routeLayout']>
    },
  }
  return { core: fakeLayoutCore({ routing }), asked, detour }
}

const preview = (core: LayoutCore | undefined) =>
  computeDragPreview(
    { kind: 'connecting', fromNodeId: 'n1' },
    boxes,
    { x: 300, y: 25 },
    {
      canvas,
      selectableBoxes: boxes,
      ...(core === undefined ? {} : { core }),
    },
  )

describe('computeDragPreview — connecting through the core', () => {
  it('draws the core’s route for the tentative edge', () => {
    const { core, asked, detour } = fixedCore()
    const drawn = preview(core)
    expect(drawn?.kind).toBe('line')
    if (drawn?.kind !== 'line') return
    expect(drawn.path).toEqual(detour)
    // The existing edge takes part in the side search; the tentative one is last.
    expect(asked).toEqual([2])
  })

  it('draws no line for a board the core refuses to route, and throws anything else', () => {
    const throwing = (err: Error) =>
      fakeLayoutCore({
        routing: {
          routeLayout: () => {
            throw err
          },
        },
      })
    const refused = Object.assign(new Error('edge_route_layout refused its input'), {
      name: 'CoreInputRefused',
    })
    expect(preview(throwing(refused))).toEqual({ kind: 'line', path: [], arrows: [] })
    const defect = new Error('garbled')
    expect(() => preview(throwing(defect))).toThrow(defect)
  })

  it.each([
    'CoreInstanceTrapped',
    'CoreUnrecoverable',
  ])('draws no line for the frame whose routing %s, rather than throwing out of a pointer move', (name) => {
    const trapped = Object.assign(new Error('edge_route_layout trapped'), { name })
    const core = fakeLayoutCore({
      routing: {
        routeLayout: () => {
          throw trapped
        },
      },
    })
    expect(preview(core)).toEqual({ kind: 'line', path: [], arrows: [] })
  })

  it('routes through this realm’s own core when it is handed none', () => {
    const drawn = preview(undefined)
    if (drawn?.kind !== 'line') throw new Error('expected a line')
    expect(drawn.path.length).toBeGreaterThanOrEqual(2)
    expect(drawn.path).not.toEqual(fixedCore().detour)
  })
})
