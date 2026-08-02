import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { describe, expect } from 'vitest'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

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
