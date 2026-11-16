import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { EdgeAnchorOverride } from '../../layout/edges/edge-sides.js'
import { layoutSpatialEdges } from '../../layout/spatial-canvas.js'
import { answerText } from '../wasm/answer-text.js'
import {
  committed,
  draggedNode,
  dragOverrides,
  type EditorProfile,
  editorOptions,
  profileFor,
  queryBoards,
  viaJson,
} from './boards.js'

/**
 * The recorded answers of `layoutSpatialEdges`, the edge-only layout the
 * editor's drag layers run on every pointer move (ADR-0054 step 7, S18a):
 * each corpus board with its first edge-touching box moved a few steps, under
 * the drag layers' options and the side overrides they hand — every edge the
 * gesture does not carry held where the committed layout drew it, and the
 * carried edges either re-sided (`fresh`) or held at their sides (`cached`).
 *
 * A record holds the moved canvas and the overrides as JSON reads them back,
 * and the edge layer as `scene_wire` writes it.
 */

export interface EdgesInput {
  readonly id: string
  readonly canvas: SpatialCanvas
  readonly profile: EditorProfile
  readonly overrides: readonly (readonly [string, EdgeAnchorOverride])[]
}

export interface EdgesRecord extends EdgesInput {
  readonly answer: string
}

export function edgesAnswer(input: EdgesInput): EdgesRecord {
  const nodes = layoutSpatialEdges(input.canvas, {
    ...editorOptions(input.profile),
    edgeSideOverrides: new Map(input.overrides),
  })
  const answer = answerText(nodes)
  if (answer === undefined) throw new Error(`query-oracle: ${input.id} drew a non-finite number`)
  return { ...input, answer }
}

/** How far the carried box has travelled on each recorded frame. */
const STEPS: readonly (readonly [number, number])[] = [
  [24, 0],
  [-40, 32],
  [120, -80],
  [0, 260],
]

export function edgesInputs(): readonly EdgesInput[] {
  return queryBoards().flatMap((board, b) => {
    const profile = profileFor(board.canvas, b)
    const moved = draggedNode(board.canvas)
    if (moved === undefined) return []
    const { scene, anchors } = committed(board.canvas, profile)
    const carried = new Set(
      board.canvas.edges
        .filter((e) => e.from.node === moved.id || e.to.node === moved.id)
        .map((e) => e.id),
    )
    return STEPS.flatMap(([dx, dy], s) =>
      (['fresh', 'cached'] as const).map((mode) => {
        const canvas: SpatialCanvas = {
          ...board.canvas,
          nodes: board.canvas.nodes.map((n) =>
            n.id === moved.id ? { ...n, x: n.x + dx, y: n.y + dy } : n,
          ),
        }
        return viaJson({
          id: `${board.name}#${s}/${mode}`,
          canvas,
          profile,
          overrides: dragOverrides(scene, anchors, carried, mode === 'cached'),
        })
      }),
    )
  })
}
