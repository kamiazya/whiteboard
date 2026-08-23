import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { type EdgeAnchorPair, routeCacheKey } from './spatial-edges.js'

/**
 * The route cache is scoped to one `assignEdgeAnchors` call, spanning every
 * region and both runs of the side-choice search. That is sound only because
 * the key names every input `routeEdge` actually varies on: `nodes` and
 * `style` are fixed for the whole call, an edge is the same object in every
 * region, and its obstacle list is derived from those two — leaving the
 * anchor pair as the only thing that moves.
 *
 * So the key has to cover the anchor pair COMPLETELY. A field `routeEdge`
 * reads but the key omits is not a slow path, it is a wrong path: two
 * genuinely different routes collapse onto one cache entry and the search
 * scores geometry it never drew. This pins each field individually.
 */
const edge: CanvasEdge = { id: 'e1', fromNode: 'a', toNode: 'b' }
const base: EdgeAnchorPair = {
  from: { x: 10, y: 20 },
  to: { x: 30, y: 40 },
  fromSide: 'right',
  toSide: 'left',
  fromLaneDepth: 20,
  toLaneDepth: 20,
}

describe('routeCacheKey — complete over everything routeEdge reads', () => {
  it('equal anchors key equally, whatever the object identity', () => {
    expect(routeCacheKey(edge, { ...base, from: { ...base.from! }, to: { ...base.to! } })).toBe(
      routeCacheKey(edge, base),
    )
  })

  it('a different edge keys differently even with identical anchors', () => {
    expect(routeCacheKey({ ...edge, id: 'e2' }, base)).not.toBe(routeCacheKey(edge, base))
  })

  it.each([
    ['from.x', { ...base, from: { x: 11, y: 20 } }],
    ['from.y', { ...base, from: { x: 10, y: 21 } }],
    ['to.x', { ...base, to: { x: 31, y: 40 } }],
    ['to.y', { ...base, to: { x: 30, y: 41 } }],
    ['fromSide', { ...base, fromSide: 'top' as const }],
    ['toSide', { ...base, toSide: 'bottom' as const }],
    ['fromLaneDepth', { ...base, fromLaneDepth: 21 }],
    ['toLaneDepth', { ...base, toLaneDepth: 21 }],
  ])('changing %s changes the key', (_field, changed) => {
    expect(routeCacheKey(edge, changed)).not.toBe(routeCacheKey(edge, base))
  })

  it('an absent anchor pair keys distinctly from any present one', () => {
    expect(routeCacheKey(edge, undefined)).not.toBe(routeCacheKey(edge, base))
  })
})
