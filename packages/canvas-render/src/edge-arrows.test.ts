import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { edgeArrowEnds, edgeArrowPolygons } from './edge-arrows.js'

type Point = { x: number; y: number }

const edge = (
  path: readonly Point[],
  fromEnd: 'none' | 'arrow',
  toEnd: 'none' | 'arrow',
): ResolvedEdgeNode => ({
  kind: 'edge',
  id: 'e',
  path,
  fromSide: 'right',
  toSide: 'left',
  fromEnd,
  toEnd,
})

/** Rounded so a wing corner's `-0` or float noise does not decide equality. */
const rounded = (points: readonly Point[] | undefined) =>
  (points ?? []).map((p) => ({
    x: Math.round(p.x * 1000) / 1000 + 0,
    y: Math.round(p.y * 1000) / 1000 + 0,
  }))

const RIGHTWARD = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
]

describe('edge arrowhead polygons', () => {
  it('places a target arrowhead tip-first, its base 10 back along the segment and 4 either side', () => {
    const [arrow] = edgeArrowPolygons(edge(RIGHTWARD, 'none', 'arrow'))
    expect(rounded(arrow?.points)).toEqual([
      { x: 100, y: 0 },
      { x: 90, y: 4 },
      { x: 90, y: -4 },
    ])
  })

  it('turns with the segment it ends', () => {
    const down = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ]
    const [arrow] = edgeArrowPolygons(edge(down, 'none', 'arrow'))
    expect(rounded(arrow?.points)).toEqual([
      { x: 0, y: 100 },
      { x: -4, y: 90 },
      { x: 4, y: 90 },
    ])
  })

  it('draws a source arrow first, pointing back at the source', () => {
    const arrows = edgeArrowPolygons(edge(RIGHTWARD, 'arrow', 'arrow'))
    expect(arrows).toHaveLength(2)
    expect(rounded(arrows[0]?.points)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: -4 },
      { x: 10, y: 4 },
    ])
    expect(edgeArrowEnds(edge(RIGHTWARD, 'arrow', 'none'))).toEqual({ from: true, to: false })
  })

  it('draws nothing at an end with no direction', () => {
    const point = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ]
    expect(edgeArrowPolygons(edge(point, 'arrow', 'arrow'))).toEqual([])
    expect(edgeArrowEnds(edge(point, 'arrow', 'arrow'))).toEqual({ from: false, to: false })
  })
})
