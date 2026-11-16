import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { BoundingBox, SceneNode } from '@kamiazya/whiteboard-scene'
import type { QueryBox, QueryNumbers } from '../query-core.js'
import { placeCommentBubble, type Size } from './comment-placement.js'
import type { Point } from './edges/edge-geometry.js'
import {
  edgeLabelPlacement,
  frameTitleObstacles,
  type LabelObstacle,
  type LabelSize,
  labelObstacles,
} from './edges/edge-label-anchor.js'
import type { LayoutCore } from './edges/layout-core.js'
import { outlineContentBox } from './nodes/node-outline.js'
import { numbersOf, queried, tupleOf } from './query-switch.js'

// The geometry an editor asks of the layout on its own (ADR-0054 step 7,
// S18d), each answered as `core` says under `impl.layoutQuery`: where an
// edge's label goes and what it avoids, where a comment's compose bubble
// goes, and the box a shaped node's body is edited in. The functions they
// switch between stay the composer's own, which calls them without a core.

const boxOf = (b: {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}): QueryBox => [b.x, b.y, b.w, b.h]

function boundingBoxOf(value: QueryNumbers | undefined): BoundingBox | undefined {
  const box = tupleOf(value, 4)
  if (box === undefined) return undefined
  const [x, y, w, h] = box as [number, number, number, number]
  return { x, y, w, h }
}

function boxesOf(value: QueryNumbers | undefined): BoundingBox[] | undefined {
  if (!Array.isArray(value)) return undefined
  const boxes = value.map(boundingBoxOf)
  return boxes.includes(undefined) ? undefined : (boxes as BoundingBox[])
}

/** `edgeLabelPlacement` as `core` says: where a label of `size` sits on a drawn path. */
export function queryEdgeLabelPlacement(
  core: LayoutCore | undefined,
  path: readonly Point[],
  size: LabelSize,
  obstacles: readonly LabelObstacle[],
  rounded?: boolean,
): Point | undefined {
  // A path that draws no line answers no place, which is an answer, not a miss.
  const none = Symbol('none')
  const placed = queried<Point | typeof none>(core, {
    request: () => ({
      query: 'label-placement',
      path: path.map((p) => [p.x, p.y] as const),
      size: [size.w, size.h],
      obstacles: obstacles.map(boxOf),
      rounded: rounded === true,
    }),
    ts: () => edgeLabelPlacement(path, size, obstacles, rounded) ?? none,
    read: (answer) => {
      const [at] = numbersOf(answer) ?? []
      if (Array.isArray(at) && at.length === 0) return none
      const xy = tupleOf(at, 2)
      return xy === undefined ? undefined : { x: xy[0] as number, y: xy[1] as number }
    },
  })
  return placed === none ? undefined : placed
}

/**
 * What an edge label avoids, as `core` says: the frame titles among the
 * scene's runs (`frameTitleObstacles`) and every obstacle with them
 * (`labelObstacles`), so a label editor and a drag preview avoid what the
 * layout's own labels avoid.
 */
export function queryLabelObstacles(
  core: LayoutCore | undefined,
  nodes: readonly SpatialNode[],
  sceneNodes: readonly SceneNode[],
): { readonly titles: LabelObstacle[]; readonly obstacles: LabelObstacle[] } {
  return queried(core, {
    request: () => ({
      query: 'label-obstacles',
      nodes,
      runs: sceneNodes.flatMap((entry) =>
        entry.kind === 'textRun' && entry.annotates !== undefined
          ? [[entry.annotates.kind, entry.annotates.id, boxOf(entry.bbox)] as const]
          : [],
      ),
    }),
    ts: () => {
      const titles = frameTitleObstacles(nodes, sceneNodes)
      return { titles, obstacles: labelObstacles(nodes, titles) }
    },
    read: (answer) => {
      const [titles, obstacles] = (numbersOf(answer) ?? []).map(boxesOf)
      return titles === undefined || obstacles === undefined ? undefined : { titles, obstacles }
    },
  })
}

/** `placeCommentBubble` as `core` says: the least-covered spot for a bubble of `size` near `anchor`. */
export function queryCommentBubble(
  core: LayoutCore | undefined,
  anchor: Point,
  size: Size,
  obstacles: readonly BoundingBox[],
): BoundingBox {
  return queried(core, {
    request: () => ({
      query: 'comment-bubble',
      anchor: [anchor.x, anchor.y],
      size: [size.w, size.h],
      obstacles: obstacles.map(boxOf),
    }),
    ts: () => placeCommentBubble(anchor, size, obstacles),
    read: (answer) => boundingBoxOf(numbersOf(answer)?.[0]),
  })
}

/**
 * `outlineContentBox` over the bundled silhouettes as `core` says: the box a
 * shaped node's content is inscribed in.
 */
export function queryOutlineContentBox(
  core: LayoutCore | undefined,
  shapeId: string | undefined,
  box: BoundingBox,
): BoundingBox {
  return queried(core, {
    request: () => ({
      query: 'outline-content-box',
      ...(shapeId === undefined ? {} : { shape: shapeId }),
      box: boxOf(box),
    }),
    ts: () => outlineContentBox(shapeId, box),
    read: (answer) => boundingBoxOf(numbersOf(answer)?.[0]),
  })
}
