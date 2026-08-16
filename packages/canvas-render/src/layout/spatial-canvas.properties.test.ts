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
 * Keyed off the same `spatialNodeArb` file pool as the facet resolver
 * above, so generated canvases exercise every `composeFileMarkdown` path:
 * a body that renders, an empty body that degrades, and a reference the
 * resolver does not know.
 */
function fakeResolveFileMarkdown(file: string): MdastRoot | undefined {
  if (file === 'a.md') {
    return {
      type: 'root',
      children: [
        { type: 'heading', depth: 2, children: [{ type: 'text', value: 'Body' }] },
        { type: 'paragraph', children: [{ type: 'text', value: 'prose that wraps somewhere' }] },
      ],
    }
  }
  if (file === 'notes/b.md') return { type: 'root', children: [] }
  return undefined
}

/**
 * Root-shaped bodies whose CHILDREN layout cannot dispatch on. Every one
 * passes a `{type:'root', children: unknown[]}` shape check, which is what
 * a caller validating only the envelope would apply.
 */
const malformedBodyArb: fc.Arbitrary<MdastRoot> = fc
  .array(
    fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.integer(),
      fc.record({ type: fc.constantFrom('bogus', 'heading', 'code', 'list', 'table') }),
      fc.record({ type: fc.constant('heading'), depth: fc.integer({ min: 1, max: 6 }) }),
    ),
    { minLength: 1, maxLength: 4 },
  )
  .map((children) => ({ type: 'root', children }) as unknown as MdastRoot)

describe('layoutSpatialCanvas markdown-body properties (PBT)', () => {
  const bare = { measure, parseBody: fakeParseBody, appearance }
  const withMarkdown = { ...bare, resolveFileMarkdown: fakeResolveFileMarkdown }

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'a resolving markdown resolver never throws and renders identically twice (determinism)',
    (canvas) => {
      const svgA = renderSceneToSvg(layoutSpatialCanvas(canvas, withMarkdown), { padding: 8 })
      const svgB = renderSceneToSvg(layoutSpatialCanvas(canvas, withMarkdown), { padding: 8 })
      expect(svgA).toBe(svgB)
    },
  )

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'an installed-but-silent resolver changes nothing (additivity)',
    (canvas) => {
      const withNoOpSeam = layoutSpatialCanvas(canvas, {
        ...withMarkdown,
        resolveFileMarkdown: () => undefined,
      })
      expect(withNoOpSeam).toEqual(layoutSpatialCanvas(canvas, bare))
    },
  )

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'a resolver that always throws is indistinguishable from no resolver (totality)',
    (canvas) => {
      const withThrowingSeam = layoutSpatialCanvas(canvas, {
        ...withMarkdown,
        resolveFileMarkdown: () => {
          throw new Error('simulated resolver failure')
        },
      })
      expect(withThrowingSeam).toEqual(layoutSpatialCanvas(canvas, bare))
    },
  )

  fcTest.prop([spatialCanvasArb, malformedBodyArb], withDefaults())(
    'a body that is root-shaped but structurally invalid never aborts the canvas',
    (canvas, body) => {
      // The throwing-resolver property above only covers the resolver CALL,
      // which was already guarded. This covers the return VALUE: a caller
      // whose own validation checks only `{type:'root', children:[...]}`
      // can hand over children layout cannot dispatch on, and those throw
      // from inside the layout call rather than the resolver.
      expect(() =>
        layoutSpatialCanvas(canvas, { ...bare, resolveFileMarkdown: () => body }),
      ).not.toThrow()
    },
  )

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'a resolved markdown body always outranks a resolved facet card',
    (canvas) => {
      // Stated against what the CARD-only layout actually rendered, not
      // against the canvas: a node too small for any content degrades both
      // seams, and asserting unconditionally would make this property pass
      // vacuously on exactly those canvases (which the generator produces —
      // it found this on a 0x0 node).
      const cardOnly = collectRunText(
        layoutSpatialCanvas(canvas, { ...bare, resolveFileFacets: fakeResolveFileFacets }).nodes,
      )
      if (!cardOnly.includes('Card')) return

      const both = collectRunText(
        layoutSpatialCanvas(canvas, {
          ...withMarkdown,
          resolveFileFacets: fakeResolveFileFacets,
        }).nodes,
      )
      expect(both).toContain('Body')
      expect(both).not.toContain('Card')
    },
  )
})

/** Every run's text anywhere in a scene, for content-level assertions. */
function collectRunText(nodes: readonly unknown[]): string[] {
  const out: string[] = []
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return
    const entry = node as { kind?: string; text?: string; runs?: unknown[]; children?: unknown[] }
    if (entry.kind === 'textRun' && typeof entry.text === 'string') out.push(entry.text)
    for (const run of entry.runs ?? []) visit(run)
    for (const child of entry.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

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
