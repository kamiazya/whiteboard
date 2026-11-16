import type { Rect } from './generated/geometry.zod.js'

/**
 * Whether `outer` fully contains `inner` (inclusive borders). A rect that
 * FULLY CONTAINS an edge's endpoint node (a group frame around its member)
 * can never be treated as an obstacle to route around — every route out of
 * the contained node still has to cross it — so both `deriveDefaultSides`'s
 * occlusion filter (spatial-edges.ts) and `endpoint-body-ink`'s exclusion
 * reuse this SAME predicate rather than each inventing their own; tidy's
 * frame membership asks it too.
 */
export function fullyContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}
