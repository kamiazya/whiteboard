import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { CoreImpl, CoreMismatch, LayoutCore } from '../../layout/edges/layout-core.js'
import {
  layoutSpatialCanvasWithAnchors,
  type SpatialLayoutOptions,
} from '../../layout/spatial-canvas.js'
import { createFakeMeasure } from '../fake-measure.js'
import { clusteredLayout, ROUTING_CORPUS, syntheticLayouts } from '../routing-corpus.js'
import { built, requireWasm, wasmBytes } from './glue.js'

/**
 * `SpatialLayoutOptions.core` over the REAL core, as a composition root
 * will hand it: `@kamiazya/whiteboard-core-wasm`'s `Core` taken as
 * canvas-render's `RoutingCore`, through the whole layout. In this project
 * the TypeScript side's search and router resolve to their per-module Rust
 * ports, so what `differential` holds here is the one-call export against
 * the composer's per-module orchestration over the corpus boards, in both
 * routing styles; the TypeScript itself is held to each port by the other
 * `*.rust.test.ts` differentials.
 */

const base: SpatialLayoutOptions = {
  measure: createFakeMeasure(),
  parseBody: (text) => ({
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }),
  appearance: {
    resolveNode: () => ({}),
    resolveEdge: () => ({}),
    resolveLabel: () => ({}),
  },
}

const boards = [
  ...ROUTING_CORPUS,
  ...syntheticLayouts(40),
  clusteredLayout({ clusters: 3, nodesPerCluster: 5, edgesPerCluster: 6, seed: 7 }),
]

const canvasesOf = (board: (typeof boards)[number]): SpatialCanvas[] =>
  (['straight', 'orthogonal'] as const).map(
    (routing) =>
      ({
        nodes: [...board.nodes],
        edges: [...board.edges],
        facets: { 'visual.edges/v0': { routing } },
      }) as SpatialCanvas,
  )

describe.runIf(built)('the routing core switch over the real core', () => {
  const routing = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  const layout = (canvas: SpatialCanvas, impl: CoreImpl | undefined) => {
    const mismatches: CoreMismatch[] = []
    const core: LayoutCore | undefined =
      impl === undefined
        ? undefined
        : { routing, impl: { routeLayout: impl }, onMismatch: (m) => mismatches.push(m) }
    return {
      ...layoutSpatialCanvasWithAnchors(canvas, { ...base, ...(core ? { core } : {}) }),
      mismatches,
    }
  }

  it('reports no mismatch under differential, and rust draws the same boards', () => {
    let canvases = 0
    for (const board of boards) {
      for (const canvas of canvasesOf(board)) {
        canvases += 1
        const reference = layout(canvas, undefined)
        const differential = layout(canvas, 'differential')
        expect(differential.mismatches, board.name).toEqual([])
        expect(differential.scene, board.name).toEqual(reference.scene)
        const rust = layout(canvas, 'rust')
        expect(rust.mismatches, board.name).toEqual([])
        expect(rust.scene, board.name).toEqual(reference.scene)
        expect([...rust.anchors], board.name).toEqual([...reference.anchors])
      }
    }
    // Every board, both styles: the loop ran over what it names.
    expect(canvases).toBe(boards.length * 2)
  })
})
