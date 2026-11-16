import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CanvasLayoutCore } from '../../canvas-core.js'
import type { SpatialLayoutOptions } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import {
  overlayReferences,
  referenceSeamsFromWire,
  referenceWire,
  referenceWireFor,
} from '../../references/wire.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { fakeLayoutCore } from '../fake-layout-core.js'
import { createFakeMeasure } from '../fake-measure.js'
import { testLayoutCore } from '../test-layout-core.js'
import { built, requireWasm, wasmBytes } from './glue.js'

/**
 * A surface's file-node chrome — the readable label it knows a reference by
 * and the references it holds as dangling — laid over a keeper's wire the way
 * the web editor does (the cut to the canvas, then `overlayReferences`),
 * through the REAL core: the core answers every board, never declining one,
 * and its scene is the TypeScript composer's.
 */
const inner: SpatialCanvas = {
  nodes: [textNode({ id: 'i', x: 0, y: 0, width: 120, height: 60, text: 'inside' })],
  edges: [],
}

const files = (spec: readonly (readonly [string, string, number, number])[]): SpatialNode[] =>
  spec.map(([id, file, width, height], i) =>
    fileNode({ id, file, x: (i % 2) * 320, y: Math.floor(i / 2) * 220, width, height }),
  )

const keeper = referenceWire(
  new Map([
    ['doc-a', { name: 'Stored A', canvas: inner }],
    ['doc-b', { name: 'Stored B', body: '# B\n\nprose under a label' }],
    ['doc-empty', { name: 'Empty', canvas: { nodes: [], edges: [] } }],
    ['doc-gone', null],
  ]),
  { extras: new Map([['doc-b', { label: 'Keeper label' }]]) },
)

const chrome = {
  labels: new Map([
    ['doc-a', 'Alpha'],
    ['doc-b', 'Beta'],
    ['doc-unloaded', 'Named only by the surface'],
    ['doc-elsewhere', 'Not on any board'],
    ['doc-256', 'Past the budget'],
  ]),
  missing: new Set(['doc-gone', 'doc-unloaded', 'doc-257']),
}

const boards: readonly { name: string; canvas: SpatialCanvas; expanded: readonly string[] }[] = [
  {
    name: 'resolved, labelled and expanded',
    canvas: {
      nodes: files([
        ['fa', 'doc-a', 260, 180],
        ['fb', 'doc-b', 260, 180],
      ]),
      edges: [{ id: 'e', from: { node: 'fa' }, to: { node: 'fb' } }],
    },
    expanded: ['fa', 'fb'],
  },
  {
    name: 'labelled cards, collapsed',
    canvas: {
      nodes: files([
        ['fa', 'doc-a', 160, 80],
        ['fe', 'doc-empty', 160, 80],
      ]),
      edges: [],
    },
    expanded: [],
  },
  {
    name: 'dangling: looked up and gone, and named only by the surface',
    canvas: {
      nodes: files([
        ['fg', 'doc-gone', 160, 80],
        ['fu', 'doc-unloaded', 160, 80],
        ['fx', 'doc-nobody', 160, 80],
      ]),
      edges: [],
    },
    expanded: ['fg'],
  },
  {
    // Two more distinct references than the walk's loading budget (256): the
    // budget bounds what loads, never which card keeps its chrome.
    name: 'past the loading budget',
    canvas: {
      nodes: Array.from({ length: 258 }, (_, i) =>
        fileNode({
          id: `n${i}`,
          file: `doc-${i}`,
          x: (i % 20) * 60,
          y: Math.floor(i / 20) * 40,
          width: 50,
          height: 30,
        }),
      ),
      edges: [],
    },
    expanded: [],
  },
]

describe.runIf(built)("a surface's reference chrome through the real core", () => {
  // Made in `beforeAll`, not in this factory: vitest runs a skipped suite's
  // factory to collect it, so a core made here fails the file where there is
  // no artifact instead of skipping it.
  let real: Core
  beforeAll(() => {
    real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })
  const answered = { compared: 0, refused: [] as string[] }
  const counting: CanvasLayoutCore = {
    layoutSpatialCanvas(request, highlight) {
      const answer = real.layoutSpatialCanvas(request, highlight)
      if ('refused' in answer) answered.refused.push(answer.refused.reason)
      else answered.compared += 1
      return answer
    },
  }
  const lay = (canvas: SpatialCanvas, options: SpatialLayoutOptions) =>
    layoutSpatialCanvasWithAnchors(canvas, {
      ...options,
      core: fakeLayoutCore({ routing: real, layout: counting }),
    })

  it('draws what the TypeScript draws', () => {
    for (const { name, canvas, expanded } of boards) {
      const wire = overlayReferences(referenceWireFor(keeper, { canvases: [canvas] }), chrome)
      const options: SpatialLayoutOptions = {
        core: testLayoutCore(),
        measure: createFakeMeasure(),
        appearance: createSpatialTheme({ mode: 'light' }),
        references: referenceSeamsFromWire(wire),
        expandFileNode: (node) => expanded.includes(node.id),
      }
      const reference = layoutSpatialCanvasWithAnchors(canvas, options)
      // The chrome reaches every board's scene, so agreeing on it judges something.
      const bare = layoutSpatialCanvasWithAnchors(canvas, {
        ...options,
        references: referenceSeamsFromWire(referenceWireFor(keeper, { canvases: [canvas] })),
      })
      expect(bare.scene, name).not.toEqual(reference.scene)
      expect(lay(canvas, options).scene, name).toEqual(reference.scene)
    }
    expect(answered.compared).toBe(boards.length)
    expect(answered.refused).toEqual([])
  })
})
