/**
 * How far right and down a laid-out block reaches from its own origin.
 *
 * Both overlay layers size a bubble around content they have just laid out
 * at the origin, and did it with the same `Math.max(0, ...)` pair written
 * twice. One concept, one caller-agnostic helper — an edge contributes
 * nothing because its extent is its route, which a bubble never wraps.
 */

import type { SceneNode } from '@kamiazya/whiteboard-scene'

export function contentExtent(nodes: readonly SceneNode[]): {
  readonly right: number
  readonly bottom: number
} {
  return {
    right: Math.max(
      0,
      ...nodes.map((node) => (node.kind === 'edge' ? 0 : node.bbox.x + node.bbox.w)),
    ),
    bottom: Math.max(
      0,
      ...nodes.map((node) => (node.kind === 'edge' ? 0 : node.bbox.y + node.bbox.h)),
    ),
  }
}
