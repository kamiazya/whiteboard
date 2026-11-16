import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import type { Point } from '../../layout/edges/edge-geometry.js'
import {
  edgeLabelPlacement,
  frameTitleObstacles,
  type LabelObstacle,
  labelObstacles,
} from '../../layout/edges/edge-label-anchor.js'
import { hex } from '../compose-canvas-oracle/oracle.js'
import { committed, profileFor, queryBoards, viaJson } from './boards.js'

/**
 * The recorded answers of where an edge's label goes (ADR-0054 step 7,
 * S18a): `edgeLabelPlacement` over every edge the corpus boards draw, at the
 * size of the editor's inline label editor and of a short and a long label,
 * along the drawn path and along its rounded flattening, with the obstacles
 * the editor hands it — `labelObstacles` of the canvas's boxes plus
 * `frameTitleObstacles` of the committed scene's frame titles, both recorded
 * as their own answers too — and hand-written paths: degenerate ones, a
 * crowd the label has to slide out of, and one it cannot leave.
 *
 * Every double is the hex of its bits; an absent placement is `null`.
 */

type Hex = readonly string[]

export type LabelPlacementRecord =
  | {
      readonly kind: 'place'
      readonly id: string
      readonly path: readonly Hex[]
      readonly size: Hex
      readonly obstacles: readonly Hex[]
      readonly rounded: boolean
      readonly answer: Hex | null
    }
  | {
      readonly kind: 'obstacles'
      readonly id: string
      readonly nodes: readonly SpatialNode[]
      /** The committed scene's text runs that annotate an element, which is what `frameTitleObstacles` reads. */
      readonly runs: readonly SceneNode[]
      readonly titles: readonly Hex[]
      readonly answer: readonly Hex[]
    }

const fromHex = (h: string): number =>
  new Float64Array(new BigUint64Array([BigInt(`0x${h}`)]).buffer)[0] ?? Number.NaN
const pointOf = ([x, y]: Hex): Point => ({ x: fromHex(x ?? ''), y: fromHex(y ?? '') })
const boxOf = ([x, y, w, h]: Hex): LabelObstacle => ({
  x: fromHex(x ?? ''),
  y: fromHex(y ?? ''),
  w: fromHex(w ?? ''),
  h: fromHex(h ?? ''),
})
const pointHex = (p: Point): Hex => [hex(p.x), hex(p.y)]
const boxHex = (b: LabelObstacle): Hex => [hex(b.x), hex(b.y), hex(b.w), hex(b.h)]

type PlaceRecord = Extract<LabelPlacementRecord, { kind: 'place' }>
type ObstaclesRecord = Extract<LabelPlacementRecord, { kind: 'obstacles' }>

/** A record's answer, re-computed from its inputs. */
export function labelPlacementAnswer(record: LabelPlacementRecord): LabelPlacementRecord {
  if (record.kind === 'obstacles') {
    const titles = frameTitleObstacles(record.nodes, record.runs)
    return {
      ...record,
      titles: titles.map(boxHex),
      answer: labelObstacles(record.nodes, titles).map(boxHex),
    }
  }
  const [w, h] = record.size.map(fromHex)
  const placed = edgeLabelPlacement(
    record.path.map(pointOf),
    { w: w ?? 0, h: h ?? 0 },
    record.obstacles.map(boxOf),
    record.rounded,
  )
  return { ...record, answer: placed === undefined ? null : pointHex(placed) }
}

function place(
  id: string,
  path: readonly Point[],
  size: readonly [number, number],
  obstacles: readonly LabelObstacle[],
  rounded: boolean,
): PlaceRecord {
  return labelPlacementAnswer({
    kind: 'place',
    id,
    path: path.map(pointHex),
    size: size.map(hex),
    obstacles: obstacles.map(boxHex),
    rounded,
    answer: null,
  }) as PlaceRecord
}

/** The inline label editor's box, a short label and a long one. */
const SIZES: readonly (readonly [number, number])[] = [
  [160, 28],
  [36, 18],
  [260, 40],
]

function boardRecords(): LabelPlacementRecord[] {
  return queryBoards().flatMap((board, b) => {
    const profile = profileFor(board.canvas, b)
    const { scene } = committed(board.canvas, profile)
    // The runs that annotate an element: the only ones it reads, edge labels among them.
    const runs = viaJson(
      scene.nodes.filter((n) => n.kind === 'textRun' && n.annotates !== undefined),
    )
    const obstacles: ObstaclesRecord = labelPlacementAnswer({
      kind: 'obstacles',
      id: `${board.name}/obstacles`,
      nodes: board.canvas.nodes,
      runs,
      titles: [],
      answer: [],
    }) as ObstaclesRecord
    const boxes = obstacles.answer.map(boxOf)
    const edges = scene.nodes.flatMap((n) => (n.kind === 'edge' ? [n] : []))
    const placed = edges.flatMap((edge, e) =>
      [false, true].map((rounded) =>
        place(
          `${board.name}/${edge.id}${rounded ? '/rounded' : ''}`,
          edge.path,
          SIZES[(e + (rounded ? 1 : 0)) % SIZES.length] as readonly [number, number],
          boxes,
          rounded,
        ),
      ),
    )
    return [obstacles, ...placed]
  })
}

/** A polyline from its coordinates, x then y. */
const path = (...xy: readonly number[]): Point[] =>
  xy.flatMap((x, i) => (i % 2 === 0 ? [{ x, y: xy[i + 1] ?? 0 }] : []))

/** An obstacle centred on the middle of `STRAIGHT`, `radius` either way. */
const crowd = (radius: number): LabelObstacle[] => [
  { x: 100 - radius, y: -radius, w: 2 * radius, h: 2 * radius },
]

const STRAIGHT = path(0, 0, 200, 0)
const EDITOR = [160, 28] as const

type HandCase = readonly [
  string,
  readonly Point[],
  readonly LabelObstacle[],
  boolean?,
  (readonly [number, number])?,
]

/** Degenerate paths, a corner either way, slides out of a crowd and a crowd with no way out. */
const HAND: readonly HandCase[] = [
  ['no path', [], []],
  ['one point', path(5, 5), []],
  ['one place twice', path(5, 5, 5, 5), [], true],
  ['zero-length segment', path(0, 0, 0, 0, 80, 0), []],
  ['straight', STRAIGHT, []],
  ['corner', path(0, 0, 200, 0, 200, 160), []],
  ['corner rounded', path(0, 0, 200, 0, 200, 160), [], true],
  ['covered, slides', STRAIGHT, crowd(20)],
  ['covered wide, slides far', STRAIGHT, crowd(90)],
  ['nowhere clear', STRAIGHT, crowd(400)],
  ['touching only', STRAIGHT, [{ x: 180, y: -14, w: 50, h: 28 }]],
  ['short run', path(0, 0, 10, 0), crowd(30)],
  ['vertical', path(0, 0, 0, 300), [{ x: -20, y: 130, w: 40, h: 40 }]],
  ['diagonal', path(0, 0, 120, 90), [{ x: 50, y: 35, w: 20, h: 20 }], false, [36, 18]],
  ['far obstacle', STRAIGHT, [{ x: 5000, y: 5000, w: 10, h: 10 }]],
  ['not finite', path(0, 0, Number.NaN, 0, 200, 0), []],
  ['zero size', STRAIGHT, crowd(5), false, [0, 0]],
]

const handRecords = (): PlaceRecord[] =>
  HAND.map(([name, line, obstacles, rounded = false, size = EDITOR]) =>
    place(`hand/${name}`, line, size, obstacles, rounded),
  )

const run = (
  id: string,
  annotates: { kind: 'node' | 'edge'; id: string },
  x: number,
): SceneNode => ({
  kind: 'textRun',
  bbox: { x, y: -24, w: 80, h: 20 },
  baseline: 16,
  text: id,
  annotates,
})

/**
 * Runs no layout writes beside a frame's title: one annotating a box that is
 * not a frame, one an edge, and one a frame the canvas does not hold. Only
 * the title is an obstacle.
 */
function handObstacles(): ObstaclesRecord {
  return labelPlacementAnswer({
    kind: 'obstacles',
    id: 'hand/obstacles',
    nodes: viaJson([
      groupNode({ id: 'F', x: 0, y: 0, width: 400, height: 300, label: 'Frame' }),
      textNode({ id: 'B', x: 40, y: 40, width: 120, height: 60, text: 'box' }),
    ]),
    runs: [
      run('title', { kind: 'node', id: 'F' }, 0),
      run('box run', { kind: 'node', id: 'B' }, 100),
      run('edge label', { kind: 'edge', id: 'F' }, 200),
      run('gone', { kind: 'node', id: 'X' }, 300),
    ],
    titles: [],
    answer: [],
  }) as ObstaclesRecord
}

/** Every record, in file order. */
export function labelPlacementRecords(): readonly LabelPlacementRecord[] {
  return [...boardRecords(), ...handRecords(), handObstacles()]
}
