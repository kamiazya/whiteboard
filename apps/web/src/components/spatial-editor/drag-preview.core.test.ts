// @vitest-environment node

// The connect preview routes outside any layout, so it takes the Rust core's
// switch (ADR-0054) itself: a gesture that drew the TypeScript's line under
// `rust` would show a route the drop then replaces.

import type { CoreImpl, LayoutCore, RoutingCore } from '@kamiazya/whiteboard-canvas-render'
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
function fixedCore(impl: CoreImpl, mismatches: string[] = []) {
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
  const core: LayoutCore = {
    routing,
    impl: { routeLayout: impl },
    onMismatch: (m) => mismatches.push(m.kind),
  }
  return { core, asked, detour }
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

describe('computeDragPreview — connecting under the core switch', () => {
  it('draws the core’s route for the tentative edge under rust', () => {
    const { core, asked, detour } = fixedCore('rust')
    const drawn = preview(core)
    expect(drawn?.kind).toBe('line')
    if (drawn?.kind !== 'line') return
    expect(drawn.path).toEqual(detour)
    // The existing edge takes part in the side search; the tentative one is last.
    expect(asked).toEqual([2])
  })

  it('draws the TypeScript route under differential and reports the difference', () => {
    const mismatches: string[] = []
    const { core, asked, detour } = fixedCore('differential', mismatches)
    const drawn = preview(core)
    if (drawn?.kind !== 'line') throw new Error('expected a line')
    expect(drawn.path).not.toEqual(detour)
    expect(asked).toEqual([2])
    expect(mismatches).toEqual(['differs'])
  })

  it('never asks the core under ts', () => {
    const { core, asked } = fixedCore('ts')
    expect(preview(core)).toEqual(preview(undefined))
    expect(asked).toEqual([])
  })
})
