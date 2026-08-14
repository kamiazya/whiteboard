import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { describe, expect } from 'vitest'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import { type FacetCardData, layoutSpatialCanvas, layoutSpatialEdges } from './spatial-canvas.js'

const measure = createFakeMeasure()

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({ radius: 4 }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
}

/**
 * A tiny fake mdast parser mirroring the one in spatial-canvas.test.ts:
 * `'__THROW__'` simulates a markdown construct outside the caller's
 * accepted subset, exercising `layoutSpatialCanvas`'s own body-parse
 * degradation path rather than canvas-codec's real parser (a
 * cross-package dependency this package must not take).
 */
function fakeParseBody(text: string): MdastRoot {
  if (text === '__THROW__') throw new Error('simulated unsupported mdast construct')
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }
}

const positionArb = fc.integer({ min: -2000, max: 2000 })
const sizeArb = fc.integer({ min: 0, max: 2000 })
const idArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,12}$/)
const textArb = fc.constantFrom('hello', 'plain body', '__THROW__', '')

/** Covers every real SpatialNode variant plus an unrecognized `type`, so the
 * property exercises every degradation path `layoutSpatialCanvas` documents
 * (body-parse failure, unknown node kind) alongside the happy paths. */
const spatialNodeArb: fc.Arbitrary<SpatialNode> = idArb.chain((id) =>
  fc.oneof(
    fc.record({
      id: fc.constant(id),
      type: fc.constant('text' as const),
      x: positionArb,
      y: positionArb,
      width: sizeArb,
      height: sizeArb,
      text: textArb,
    }),
    fc.record({
      id: fc.constant(id),
      type: fc.constant('file' as const),
      x: positionArb,
      y: positionArb,
      width: sizeArb,
      height: sizeArb,
      file: fc.constantFrom('a.md', 'notes/b.md'),
    }),
    fc.record({
      id: fc.constant(id),
      type: fc.constant('link' as const),
      x: positionArb,
      y: positionArb,
      width: sizeArb,
      height: sizeArb,
      url: fc.constant('https://example.com'),
    }),
    fc.record({
      id: fc.constant(id),
      type: fc.constant('group' as const),
      x: positionArb,
      y: positionArb,
      width: sizeArb,
      height: sizeArb,
      label: fc.option(fc.constantFrom('Section'), { nil: undefined }),
    }),
    fc
      .record({
        id: fc.constant(id),
        x: positionArb,
        y: positionArb,
        width: sizeArb,
        height: sizeArb,
      })
      .map((n) => ({ ...n, type: 'bogus' }) as unknown as SpatialNode),
  ),
)

function uniqueById(nodes: readonly SpatialNode[]): SpatialNode[] {
  const seen = new Set<string>()
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
}

/** Edge endpoints are drawn from a small pool that overlaps but is not
 * limited to the generated node ids, so a missing-endpoint degradation is
 * exercised alongside well-formed edges. */
const edgeArb: fc.Arbitrary<CanvasEdge> = fc.record({
  id: idArb,
  fromNode: fc.constantFrom('a', 'b', 'c', 'ghost'),
  toNode: fc.constantFrom('a', 'b', 'c', 'ghost'),
})

const spatialCanvasArb: fc.Arbitrary<SpatialCanvas> = fc
  .record({
    nodes: fc.array(spatialNodeArb, { minLength: 0, maxLength: 6 }),
    edges: fc.array(edgeArb, { minLength: 0, maxLength: 3 }),
  })
  .map(({ nodes, edges }) => ({ nodes: uniqueById(nodes), edges }))

describe('layoutSpatialCanvas properties (PBT)', () => {
  fcTest.prop([spatialCanvasArb], withDefaults())(
    'never throws and renders through renderSceneToSvg without throwing, for any generated canvas',
    (canvas) => {
      expect(() => {
        const scene = layoutSpatialCanvas(canvas, { measure, parseBody: fakeParseBody, appearance })
        renderSceneToSvg(scene, { padding: 8 })
      }).not.toThrow()
    },
  )

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'composing the same canvas twice yields byte-identical SVG (determinism)',
    (canvas) => {
      const options = { measure, parseBody: fakeParseBody, appearance }
      const svgA = renderSceneToSvg(layoutSpatialCanvas(canvas, options), { padding: 4 })
      const svgB = renderSceneToSvg(layoutSpatialCanvas(canvas, options), { padding: 4 })
      expect(svgA).toBe(svgB)
    },
  )
})

/**
 * A fixed (not fc-generated) resolver keyed off `spatialNodeArb`'s file
 * pool: deterministic per file, so the property below exercises every
 * `composeFileFacets` path (usable card, degrades-to-nothing, no match)
 * across generated canvases without needing its own arbitrary.
 */
function fakeResolveFileFacets(file: string): FacetCardData | undefined {
  if (file === 'a.md') {
    return {
      title: 'Card',
      rows: [
        { label: 'type', value: 'note' },
        { label: 'tags', value: 'x, y' },
      ],
    }
  }
  if (file === 'notes/b.md') {
    // No usable content: degrades to the plain chrome+label rendering.
    return { rows: [] }
  }
  return undefined
}

describe('layoutSpatialCanvas facet-card properties (PBT)', () => {
  const optionsWithFacets = {
    measure,
    parseBody: fakeParseBody,
    appearance,
    resolveFileFacets: fakeResolveFileFacets,
  }

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'a resolving facet resolver never throws and renders identically twice (determinism)',
    (canvas) => {
      const svgA = renderSceneToSvg(layoutSpatialCanvas(canvas, optionsWithFacets), { padding: 8 })
      const svgB = renderSceneToSvg(layoutSpatialCanvas(canvas, optionsWithFacets), { padding: 8 })
      expect(svgA).toBe(svgB)
    },
  )

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'an installed-but-silent resolver changes nothing (additivity)',
    (canvas) => {
      const withNoOpSeam = layoutSpatialCanvas(canvas, {
        ...optionsWithFacets,
        resolveFileFacets: () => undefined,
      })
      const withoutSeam = layoutSpatialCanvas(canvas, {
        measure,
        parseBody: fakeParseBody,
        appearance,
      })
      expect(withNoOpSeam).toEqual(withoutSeam)
    },
  )
})

/**
 * Live-drag parity: a mid-drag preview built with `layoutSpatialEdges` over
 * the moved canvas must equal the edge-and-label suffix of the committed
 * `layoutSpatialCanvas` of that same moved canvas — detours around
 * obstacles, line jumps, and label placement included. The generator is
 * deliberately DENSE (chunky boxes on a coarse grid, edges across them,
 * jumps enabled in half the runs) so blocked paths and crossings are the
 * common case, not a lucky draw — a sparse generator would pass vacuously.
 */
const denseIds = ['a', 'b', 'c', 'd', 'e', 'f'] as const

const denseNodeArb = (id: string): fc.Arbitrary<SpatialNode> =>
  fc
    .record({
      id: fc.constant(id),
      type: fc.constantFrom('text' as const, 'group' as const),
      x: fc.constantFrom(0, 80, 160, 240, 320, 400),
      y: fc.constantFrom(0, 80, 160, 240, 320),
      width: fc.constantFrom(60, 120, 240),
      height: fc.constantFrom(60, 120, 240),
    })
    .map((n) => (n.type === 'text' ? { ...n, text: 'n' } : { ...n, label: 'G' }) as SpatialNode)

const denseEdgeArb = (index: number): fc.Arbitrary<CanvasEdge> =>
  fc
    .record({
      id: fc.constant(`e${index}`),
      fromNode: fc.constantFrom(...denseIds),
      toNode: fc.constantFrom(...denseIds),
      label: fc.option(fc.constant('flow'), { nil: undefined }),
    })
    .map(({ label, ...edge }) => (label === undefined ? edge : { ...edge, label }))

const dragScenarioArb = fc.record({
  nodes: fc.tuple(...denseIds.map(denseNodeArb)),
  edges: fc
    .array(fc.nat({ max: 4 }), { minLength: 1, maxLength: 5 })
    .chain((indices) => fc.tuple(...indices.map((_, i) => denseEdgeArb(i)))),
  routing: fc.record({
    style: fc.constantFrom(
      undefined,
      'straight' as const,
      'orthogonal' as const,
      'curved' as const,
    ),
    lineJumps: fc.constantFrom(undefined, 'arc' as const),
  }),
  carried: fc.uniqueArray(fc.constantFrom(...denseIds), { minLength: 1, maxLength: 3 }),
  dx: fc.constantFrom(-200, -80, 40, 160, 320),
  dy: fc.constantFrom(-160, -40, 80, 240),
})

describe('live-drag parity property (PBT)', () => {
  fcTest.prop([dragScenarioArb], withDefaults())(
    'mid-drag edge layout equals the committed layout of the moved canvas, obstacles and jumps included',
    ({ nodes, edges, routing, carried, dx, dy }) => {
      const carriedSet = new Set<string>(carried)
      const movedCanvas: SpatialCanvas = {
        nodes: nodes.map((n) => (carriedSet.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
        edges: [...edges],
        'x-whiteboard': { edgeRouting: routing },
      }
      const options = { measure, parseBody: fakeParseBody, appearance }
      const committed = layoutSpatialCanvas(movedCanvas, options).nodes
      const live = layoutSpatialEdges(movedCanvas, options)
      expect(live.length).toBeGreaterThan(0)
      expect(live).toEqual(committed.slice(committed.length - live.length))
    },
  )
})
