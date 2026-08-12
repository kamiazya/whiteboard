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

// listItem/tableRow are not top-level SceneNode kinds (they nest inside
// list/table), so `node.kind` can never equal them here — omitted rather
// than widened to a type Set<SceneNode['kind']> can't hold.
const TEXT_BEARING_KINDS = new Set<SceneNode['kind']>([
  'textRun',
  'heading',
  'paragraph',
  'list',
  'table',
  'codeBlock',
  'rawHtml',
  'unresolvedReference',
  'embedPlaceholder',
  'embedResolved',
])

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
      // Only 'edge'/'shape' are used today; the text-free assertion below
      // already fails a fixture that introduces any other kind, so this
      // stays total rather than growing a case per kind.
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
  it.each(SCENES)('%s has no text-bearing scene node', (_name, build) => {
    for (const node of build().nodes) {
      expect(TEXT_BEARING_KINDS.has(node.kind)).toBe(false)
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
