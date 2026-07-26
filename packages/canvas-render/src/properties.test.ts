import { describe, expect } from 'vitest'
import type { ResolvedDocBundle } from './layout/embed-recursion.js'
import { resolveEmbeds } from './layout/embed-recursion.js'
import { sceneDigest } from './scene-digest.js'
import type { Scene, SceneNode } from './scene-graph.js'
import { renderSceneToSvg } from './svg/backend.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { isWellFormedXmlFragment } from './test-utils/xml-well-formed.js'

const idArb = fc.constantFrom('A', 'B', 'C', 'D', 'E')

/** A dense, possibly-cyclic bundle: every doc may embed any subset of the others. */
const bundleArb = fc.record({
  edgesPerDoc: fc.array(fc.array(idArb, { maxLength: 5 }), { minLength: 5, maxLength: 5 }),
})

function buildBundle(edgesPerDoc: readonly string[][]): ResolvedDocBundle {
  const ids = ['A', 'B', 'C', 'D', 'E']
  const docs: ResolvedDocBundle['docs'] = {}
  ids.forEach((id, index) => {
    docs[id] = { canvasId: id, title: id, embeds: edgesPerDoc[index] ?? [] }
  })
  return { root: { canvasId: 'A' }, docs }
}

function maxDepth(node: SceneNode, depth = 0): number {
  if (node.kind !== 'embedResolved') return depth
  return Math.max(
    depth,
    ...(node.children.length > 0 ? node.children.map((c) => maxDepth(c, depth + 1)) : [depth]),
  )
}

describe('embed-recursion totality (PBT)', () => {
  fcTest.prop([bundleArb], withDefaults())(
    'terminates and never exceeds the depth cap for any dense/cyclic bundle',
    ({ edgesPerDoc }) => {
      const bundle = buildBundle(edgesPerDoc)
      const result = resolveEmbeds(bundle)
      expect(maxDepth(result)).toBeLessThanOrEqual(4) // depth cap 3 + the placeholder's own depth
    },
  )
})

const bboxArb = fc.record({
  x: fc.integer({ min: 0, max: 300 }),
  y: fc.integer({ min: 0, max: 300 }),
  w: fc.integer({ min: 0, max: 100 }),
  h: fc.integer({ min: 0, max: 100 }),
})

describe('sceneDigest determinism (PBT)', () => {
  fcTest.prop([fc.array(bboxArb, { maxLength: 8 })], withDefaults())(
    'is pure: repeated calls on the same scene yield the same digest',
    (boxes) => {
      const scene: Scene = {
        nodes: boxes.map((bbox) => ({ kind: 'thematicBreak' as const, bbox })),
      }
      expect(sceneDigest(scene)).toEqual(sceneDigest(scene))
    },
  )
})

describe('SVG serializer well-formedness (PBT)', () => {
  fcTest.prop([fc.string({ maxLength: 40 })], withDefaults({ numRuns: 100 }))(
    'produces well-formed XML for any text-run content',
    (text) => {
      const scene: Scene = {
        nodes: [
          {
            kind: 'paragraph',
            bbox: { x: 0, y: 0, w: 100, h: 16 },
            runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 10, h: 16 }, text }],
          },
        ],
      }
      expect(isWellFormedXmlFragment(renderSceneToSvg(scene))).toBe(true)
    },
  )
})
