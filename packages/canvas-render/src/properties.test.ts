import { describe, expect } from 'vitest'
import type { ResolvedDocBundle } from './layout/embed-recursion.js'
import { resolveEmbeds } from './layout/embed-recursion.js'
import { sceneBounds } from './scene-bounds.js'
import { sceneDigest } from './scene-digest.js'
import type { BoundingBox, Scene, SceneNode } from './scene-graph.js'
import type { SvgDocumentOptions } from './svg/backend.js'
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

const sceneNodeArb: fc.Arbitrary<SceneNode> = fc.oneof(
  bboxArb.map((bbox) => ({ kind: 'thematicBreak' as const, bbox })),
  fc
    .array(
      fc.record({ x: fc.integer({ min: -50, max: 350 }), y: fc.integer({ min: -50, max: 350 }) }),
      {
        maxLength: 4,
      },
    )
    .map((path) => ({
      kind: 'edge' as const,
      id: 'e',
      path,
      fromSide: 'right' as const,
      toSide: 'left' as const,
    })),
)

const sceneArb: fc.Arbitrary<Scene> = fc
  .array(sceneNodeArb, { maxLength: 6 })
  .map((nodes) => ({ nodes }))

/** Includes adversarial numeric edge cases (NaN/Infinity/negative) so the totality property covers them. */
const maybeAdversarialNumberArb = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
)

const viewBoxArb: fc.Arbitrary<BoundingBox> = fc.record({
  x: maybeAdversarialNumberArb,
  y: maybeAdversarialNumberArb,
  w: maybeAdversarialNumberArb,
  h: maybeAdversarialNumberArb,
})

const documentOptionsArb: fc.Arbitrary<SvgDocumentOptions> = fc.record(
  {
    width: maybeAdversarialNumberArb,
    height: maybeAdversarialNumberArb,
    viewBox: viewBoxArb,
    padding: maybeAdversarialNumberArb,
    background: fc.string({ maxLength: 20 }),
  },
  { requiredKeys: [] },
)

describe('renderSceneToSvg document envelope (PBT)', () => {
  fcTest.prop([sceneArb, documentOptionsArb], withDefaults({ numRuns: 50 }))(
    'never throws for any scene/options pair, including non-finite numbers',
    (scene, options) => {
      expect(() => renderSceneToSvg(scene, options)).not.toThrow()
      expect(() => sceneBounds(scene)).not.toThrow()
    },
  )

  fcTest.prop([sceneArb], withDefaults({ numRuns: 50 }))(
    'sceneBounds always has a positive-area, finite result',
    (scene) => {
      const bounds = sceneBounds(scene)
      expect(Number.isFinite(bounds.x)).toBe(true)
      expect(Number.isFinite(bounds.y)).toBe(true)
      expect(bounds.w).toBeGreaterThan(0)
      expect(bounds.h).toBeGreaterThan(0)
    },
  )

  fcTest.prop([sceneArb], withDefaults({ numRuns: 50 }))(
    'the derived viewBox contains every node bbox and every edge path point',
    (scene) => {
      const svg = renderSceneToSvg(scene, { padding: 0 })
      const match = /viewBox="([^"]+)"/.exec(svg)
      expect(match).not.toBeNull()
      const [x, y, w, h] = match![1].split(' ').map(Number)
      const contains = (px: number, py: number) => px >= x && px <= x + w && py >= y && py <= y + h

      for (const node of scene.nodes) {
        if (node.kind === 'edge') {
          for (const p of node.path) expect(contains(p.x, p.y)).toBe(true)
        } else {
          expect(contains(node.bbox.x, node.bbox.y)).toBe(true)
          expect(contains(node.bbox.x + node.bbox.w, node.bbox.y + node.bbox.h)).toBe(true)
        }
      }
    },
  )

  fcTest.prop([sceneArb, documentOptionsArb], withDefaults({ numRuns: 50 }))(
    'is deterministic: same (scene, options) renders byte-identical output',
    (scene, options) => {
      expect(renderSceneToSvg(scene, options)).toBe(renderSceneToSvg(scene, options))
    },
  )

  fcTest.prop([sceneArb, documentOptionsArb], withDefaults({ numRuns: 50 }))(
    'never emits a negative root width/height or viewBox w/h, for any adversarial option including negative numbers',
    (scene, options) => {
      const svg = renderSceneToSvg(scene, options)
      const rootMatch =
        /^<svg xmlns="[^"]*" width="(-?[\d.]+)" height="(-?[\d.]+)" viewBox="([^"]+)"/.exec(svg)
      if (!rootMatch) return // envelope not activated (no options fields set) — nothing to check
      const [, width, height, viewBox] = rootMatch
      const [, , w, h] = viewBox.split(' ')
      expect(Number(width)).toBeGreaterThanOrEqual(0)
      expect(Number(height)).toBeGreaterThanOrEqual(0)
      expect(Number(w)).toBeGreaterThanOrEqual(0)
      expect(Number(h)).toBeGreaterThanOrEqual(0)
    },
  )
})
