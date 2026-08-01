import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { renderSceneToSvg } from '@kamiazya/whiteboard-canvas-render'
import fc from 'fast-check'
import { describe, expect } from 'vitest'

import { fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { composeSpatialScene } from './spatial-scene.js'
import { createFakeMeasure } from './spatial-scene.test-utils.js'

const measure = createFakeMeasure()

const positionArbitrary = fc.integer({ min: -2000, max: 2000 })
const sizeArbitrary = fc.integer({ min: 0, max: 2000 })
const idArbitrary = fc.stringMatching(/^[a-zA-Z0-9_-]{1,12}$/)

const spatialNodeArbitrary: fc.Arbitrary<SpatialNode> = idArbitrary.chain((id) =>
  fc.oneof(
    fc.record({
      id: fc.constant(id),
      type: fc.constant('text' as const),
      x: positionArbitrary,
      y: positionArbitrary,
      width: sizeArbitrary,
      height: sizeArbitrary,
      text: fc.constantFrom('hello', '# Title', 'plain **bold** text', ''),
    }),
    fc.record({
      id: fc.constant(id),
      type: fc.constant('file' as const),
      x: positionArbitrary,
      y: positionArbitrary,
      width: sizeArbitrary,
      height: sizeArbitrary,
      file: fc.constantFrom('a.md', 'notes/b.md'),
    }),
    fc.record({
      id: fc.constant(id),
      type: fc.constant('link' as const),
      x: positionArbitrary,
      y: positionArbitrary,
      width: sizeArbitrary,
      height: sizeArbitrary,
      url: fc.constant('https://example.com'),
    }),
    fc.record({
      id: fc.constant(id),
      type: fc.constant('group' as const),
      x: positionArbitrary,
      y: positionArbitrary,
      width: sizeArbitrary,
      height: sizeArbitrary,
      label: fc.option(fc.constantFrom('Section'), { nil: undefined }),
    }),
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

const spatialCanvasArbitrary: fc.Arbitrary<SpatialCanvas> = fc
  .array(spatialNodeArbitrary, { minLength: 0, maxLength: 6 })
  .map((nodes) => ({ nodes: uniqueById(nodes), edges: [] as CanvasEdge[] }))

describe('composeSpatialScene properties', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'never throws and renders through renderSceneToSvg without throwing',
    (canvas) => {
      const scene = composeSpatialScene(canvas, { measure })
      expect(() => renderSceneToSvg(scene, { padding: 8 })).not.toThrow()
    },
  )

  fcTest.prop([spatialCanvasArbitrary, fc.integer({ min: 0, max: 5 })], withDefaults())(
    'is invariant under permutation of the node array',
    (canvas, seed) => {
      const shuffled = [...canvas.nodes]
      // deterministic pseudo-shuffle from the seed, no RNG dependency
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = (i + seed) % (i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
      }
      const a = composeSpatialScene(canvas, { measure })
      const b = composeSpatialScene({ ...canvas, nodes: shuffled }, { measure })
      expect(a).toEqual(b)
    },
  )

  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'composing the same canvas twice yields byte-identical SVG',
    (canvas) => {
      const svgA = renderSceneToSvg(composeSpatialScene(canvas, { measure }), { padding: 4 })
      const svgB = renderSceneToSvg(composeSpatialScene(canvas, { measure }), { padding: 4 })
      expect(svgA).toBe(svgB)
    },
  )
})
