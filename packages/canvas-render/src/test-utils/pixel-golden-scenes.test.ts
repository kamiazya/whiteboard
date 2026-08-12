import { describe, expect, it } from 'vitest'
import type { Scene, SceneNode } from '../scene-graph.js'
import {
  buildArrowheadsScene,
  buildJumpHopScene,
  buildRoundedCornersScene,
  buildRoundedRectScene,
} from './pixel-golden-scenes.js'

/**
 * Cheap node-layer guard for the pixel-golden harness's two hard
 * constraints (package-canvas-render.md's pixel-golden entry): text-free
 * (per the human decision excluding the halo pill) and integer-aligned
 * (what keeps every derived point — arrow wings, jump entry/exit, rounded
 * corners — off a sub-pixel boundary). A future fixture edit that violates
 * either fails here, at the node layer, instead of only as an opaque
 * screenshot diff in the browser project.
 */

// Allowlist, not a denylist of text-bearing kinds: 'edge' and 'shape' are
// the only kinds that carry no text (or text-bearing children), so anything
// else — including a future fixture edit — fails loudly here.
const GEOMETRY_ONLY_KINDS: readonly SceneNode['kind'][] = ['edge', 'shape']

function collectCoordinates(node: SceneNode): number[] {
  switch (node.kind) {
    case 'edge': {
      const numbers = node.path.flatMap((p) => [p.x, p.y])
      for (const jump of node.jumps ?? []) numbers.push(jump.x, jump.y)
      return numbers
    }
    case 'shape': {
      const numbers = [node.bbox.x, node.bbox.y, node.bbox.w, node.bbox.h]
      if (node.radius !== undefined) numbers.push(node.radius)
      return numbers
    }
    default:
      // Unreachable for committed fixtures — the allowlist test above
      // rejects any kind but 'edge'/'shape' before this matters.
      return []
  }
}

const SCENES: readonly (readonly [string, () => Scene])[] = [
  ['jump-hop', buildJumpHopScene],
  ['rounded-corners', buildRoundedCornersScene],
  ['arrowheads', buildArrowheadsScene],
  ['rounded-rect', buildRoundedRectScene],
]

describe('pixel-golden fixtures stay text-free and integer-aligned', () => {
  it.each(SCENES)('%s contains only geometry-only node kinds', (_name, build) => {
    for (const node of build().nodes) {
      expect(GEOMETRY_ONLY_KINDS).toContain(node.kind)
    }
  })

  it.each(SCENES)('%s uses only integer coordinates', (_name, build) => {
    for (const node of build().nodes) {
      for (const value of collectCoordinates(node)) {
        expect(Number.isInteger(value)).toBe(true)
      }
    }
  })
})
