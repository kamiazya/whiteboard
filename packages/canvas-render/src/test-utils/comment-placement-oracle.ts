import type { BoundingBox } from '@kamiazya/whiteboard-scene'
import {
  commentBubbleCandidates,
  commentLeaderEnd,
  nearestPointOnPolyline,
  placeCommentBubble,
} from '../layout/comment-placement.js'
import type { Point } from '../layout/edges/edge-geometry.js'
import { f64Hex } from './render-oracle/scene-dump.js'

/**
 * The recorded answers of the comment placement primitives
 * (`layout/comment-placement.ts`): the candidate boxes, the least-covered pick
 * among them, the leader's end on a bubble's corner, and the point of a
 * polyline nearest a pin. The inputs are a fixed corpus: hand-written edges
 * (touching obstacles, ties at zero and above, NaN and infinite boxes, empty,
 * single-point and zero-length paths, a point projecting past either end, two
 * segments equally near) and a deterministic sweep drawn by a linear
 * congruential generator over integers and halves, so boundaries are exact.
 * Every double is the hex of its bits, a NaN the canonical one.
 */

const hex = (value: number): string => (Number.isNaN(value) ? '7ff8000000000000' : f64Hex(value))
const point = (p: Point) => [hex(p.x), hex(p.y)]
const box = (b: BoundingBox) => [hex(b.x), hex(b.y), hex(b.w), hex(b.h)]

type Box = readonly [number, number, number, number]
type Pt = readonly [number, number]

export type CommentPlacementRecord =
  | {
      readonly kind: 'candidates'
      readonly anchor: string[]
      readonly size: string[]
      readonly answer: string[][]
    }
  | {
      readonly kind: 'place'
      readonly anchor: string[]
      readonly size: string[]
      readonly obstacles: string[][]
      readonly answer: string[]
    }
  | {
      readonly kind: 'leader'
      readonly anchor: string[]
      readonly bubble: string[]
      readonly radius: string
      readonly answer: string[]
    }
  | {
      readonly kind: 'nearest'
      readonly point: string[]
      readonly path: string[][]
      readonly answer: string[]
    }

/** A linear congruential generator: the same sequence on every run. */
function lcg(seed: number) {
  let state = seed >>> 0
  return (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % n
  }
}

const toBox = ([x, y, w, h]: Box): BoundingBox => ({ x, y, w, h })
const toPoint = ([x, y]: Pt): Point => ({ x, y })

function candidates(anchor: Pt, size: Pt): CommentPlacementRecord {
  const answer = commentBubbleCandidates(toPoint(anchor), { w: size[0], h: size[1] }).map(box)
  return { kind: 'candidates', anchor: point(toPoint(anchor)), size: size.map(hex), answer }
}

function place(anchor: Pt, size: Pt, obstacles: readonly Box[]): CommentPlacementRecord {
  const at = toPoint(anchor)
  const placed = placeCommentBubble(at, { w: size[0], h: size[1] }, obstacles.map(toBox))
  return {
    kind: 'place',
    anchor: point(at),
    size: size.map(hex),
    obstacles: obstacles.map((o) => o.map(hex)),
    answer: box(placed),
  }
}

function leader(anchor: Pt, bubble: Box, radius: number): CommentPlacementRecord {
  const end = commentLeaderEnd(toPoint(anchor), toBox(bubble), radius)
  return {
    kind: 'leader',
    anchor: point(toPoint(anchor)),
    bubble: [...bubble].map(hex),
    radius: hex(radius),
    answer: point(end),
  }
}

function nearest(at: Pt, path: readonly Pt[]): CommentPlacementRecord {
  const answer = nearestPointOnPolyline(toPoint(at), path.map(toPoint))
  return {
    kind: 'nearest',
    point: point(toPoint(at)),
    path: path.map((p) => point(toPoint(p))),
    answer: point(answer),
  }
}

/** The quadrants and the ring around a 100x40 bubble at (0, 0), each blocked or touched on purpose. */
function placeEdges(): CommentPlacementRecord[] {
  const size: Pt = [100, 40]
  const downRight: Box = [14, 14, 100, 40]
  const upRight: Box = [14, -54, 100, 40]
  const downLeft: Box = [-114, 14, 100, 40]
  const upLeft: Box = [-114, -54, 100, 40]
  return [
    place([0, 0], size, []),
    place([0, 0], size, [downRight]),
    place([0, 0], size, [downRight, upRight]),
    place([0, 0], size, [downRight, upRight, downLeft]),
    place([0, 0], size, [downRight, upRight, downLeft, upLeft]),
    // Touching on an edge, on a corner, and by zero width: no area.
    place([0, 0], size, [[114, 14, 50, 40]]),
    place([0, 0], size, [[114, 54, 10, 10]]),
    place([0, 0], size, [[50, 0, 0, 100]]),
    place([0, 0], size, [[0, 30, 200, 0]]),
    // Overlapping by a sliver on each side.
    place([0, 0], size, [[113.5, 14, 50, 40]]),
    place([0, 0], size, [[0, 53.5, 200, 10]]),
    place([0, 0], size, [[-1, 0, 15.5, 100]]),
    place([0, 0], size, [[0, -1, 100, 15.5]]),
    // Equal cover in two quadrants: the earlier keeps it.
    place([0, 0], size, [
      [14, 14, 10, 10],
      [14, -24, 10, 10],
      [-24, 14, 10, 10],
      [-24, -24, 10, 10],
    ]),
    // Not finite.
    place([0, 0], size, [[Number.NaN, 0, 10, 10]]),
    place([0, 0], size, [[0, 0, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]]),
    place([0, 0], size, [
      [
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ],
    ]),
    place([Number.NaN, 0], size, [[0, 0, 10, 10]]),
    place([0, 0], [Number.NaN, 40], [[0, 0, 10, 10]]),
    // A crowd that only the ring escapes.
    place([0, 0], size, [
      [-300, -300, 600, 600],
      [-40, -40, 80, 80],
    ]),
    place([0, 0], size, [[-200, -100, 400, 200]]),
  ]
}

function leaderEdges(): CommentPlacementRecord[] {
  const bubble: Box = [10, 20, 100, 40]
  return [
    leader([0, 0], bubble, 8),
    leader([200, 0], bubble, 8),
    leader([0, 100], bubble, 8),
    leader([200, 100], bubble, 8),
    // On the centre lines exactly, and a hair either side.
    leader([60, 40], bubble, 8),
    leader([60.000000000000014, 40.00000000000001], bubble, 8),
    leader([59.99999999999999, 39.99999999999999], bubble, 8),
    leader([0, 0], bubble, 0),
    leader([0, 0], bubble, Number.NaN),
  ]
}

function nearestEdges(): CommentPlacementRecord[] {
  return [
    nearest([5, 5], []),
    nearest([5, 5], [[1, 2]]),
    nearest(
      [5, 5],
      [
        [1, 2],
        [1, 2],
      ],
    ),
    nearest(
      [5, 5],
      [
        [0, 0],
        [10, 0],
      ],
    ),
    nearest(
      [-5, 5],
      [
        [0, 0],
        [10, 0],
      ],
    ),
    nearest(
      [15, 5],
      [
        [0, 0],
        [10, 0],
      ],
    ),
    nearest(
      [0, 0],
      [
        [0, 0],
        [10, 0],
      ],
    ),
    nearest(
      [10, 0],
      [
        [0, 0],
        [10, 0],
      ],
    ),
    // Two segments equally near: the first keeps it.
    nearest(
      [5, 5],
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ),
    nearest(
      [5, 3],
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ),
    nearest(
      [5, 7],
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ),
    nearest(
      [3, 4],
      [
        [0, 0],
        [6, 8],
        [12, 0],
      ],
    ),
    nearest(
      [5, 5],
      [
        [0, 0],
        [Number.NaN, 0],
        [10, 0],
      ],
    ),
    nearest(
      [Number.NaN, 5],
      [
        [0, 0],
        [10, 0],
      ],
    ),
    nearest(
      [5, 5],
      [
        [0, 0],
        [Number.POSITIVE_INFINITY, 0],
      ],
    ),
  ]
}

const half = (rand: (n: number) => number, span: number) => (rand(span * 4) - span * 2) / 2

function sweep(): CommentPlacementRecord[] {
  const rand = lcg(0x5eed)
  const out: CommentPlacementRecord[] = []
  for (let i = 0; i < 150; i += 1) {
    const anchor: Pt = [half(rand, 100), half(rand, 100)]
    const size: Pt = [rand(160) + 1, rand(80) + 1]
    const obstacles: Box[] = Array.from({ length: rand(9) }, () => [
      anchor[0] + half(rand, 220),
      anchor[1] + half(rand, 160),
      rand(200),
      rand(120),
    ])
    out.push(place(anchor, size, obstacles))
  }
  for (let i = 0; i < 60; i += 1) {
    const bubble: Box = [half(rand, 50), half(rand, 50), rand(120), rand(60)]
    out.push(leader([half(rand, 80), half(rand, 80)], bubble, rand(12)))
  }
  for (let i = 0; i < 120; i += 1) {
    const path: Pt[] = Array.from({ length: rand(6) }, () => [half(rand, 40), half(rand, 40)])
    out.push(nearest([half(rand, 50), half(rand, 50)], path))
  }
  return out
}

/** Every record, in file order. */
export function commentPlacementRecords(): readonly CommentPlacementRecord[] {
  return [
    candidates([0, 0], [100, 40]),
    candidates([-37.5, 112.25], [1, 1]),
    candidates([1e15, -1e15], [0, 0]),
    ...placeEdges(),
    ...leaderEdges(),
    ...nearestEdges(),
    ...sweep(),
  ]
}
