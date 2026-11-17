/**
 * One-tap tidy: deterministic normalization that respects the author's rough
 * topology instead of re-laying the canvas out wholesale. The passes are the
 * Rust core's (`crates/core/canvas-render/src/tidy`); this module is what a
 * root calls: the boxes a canvas gives tidy, the options a caller sets, and
 * the moves it answers.
 *
 * Pure and total: returns ONLY the boxes that actually move (a frame that grew
 * to hold its members carries its new size). Locked nodes never move and stand
 * as fixed obstacles, and a frame holding one is held by it; out-of-scope
 * units likewise. A board the core refuses (past its element cap) is answered
 * as one that moves nothing, beside the refusal `onRefused` hears, so a caller
 * can say it could not tidy rather than that nothing needed tidying.
 */
import {
  type CanvasEdge,
  endNode,
  isFiniteRect,
  isFrame,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { queried } from './layout/query-switch.js'
import type { LayoutCore } from './layout-core.js'
import type { LayoutRefusal } from './refusal.js'

export interface TidyNode {
  readonly id: string
  /**
   * Whether this box is a FRAME — the one thing tidy asks about a node
   * beyond its rectangle, since an outermost frame and everything more than
   * half inside it move as one unit.
   *
   * A boolean rather than the model's node kind, so the flip that dissolves
   * that union (ADR-0038 decision 3) lands in `tidyBoxes` alone.
   */
  readonly frame: boolean
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface TidyOptions {
  /** The Rust core that answers the tidy. */
  readonly core: LayoutCore
  /** Unit roots outside this set stay put (undefined = whole canvas). */
  readonly scope?: ReadonlySet<string>
  readonly locked?: (id: string) => boolean
  /**
   * The canvas's edges, by node id. With them a row is ORDERED as well as
   * aligned: a box whose connections along its own row all lie to one side
   * swaps with the nearest of them, so a hub that fans out sits between the
   * boxes it fans out to. Without them rows keep the order they were drawn.
   */
  readonly edges?: readonly Pick<CanvasEdge, 'from' | 'to'>[]
  /** Hears the core's refusal of the board, which is answered as no moves. */
  readonly onRefused?: (refusal: LayoutRefusal) => void
}

interface TidyMove {
  readonly id: string
  readonly x: number
  readonly y: number
  /** Present only on a frame that grew to hold its members. */
  readonly width?: number
  readonly height?: number
}

/**
 * The boxes a real canvas gives tidy.
 *
 * The one place that answers "is this a frame" for a stored node, so a
 * caller never spells the discriminant and the flip that dissolves it
 * (ADR-0038 decision 3) lands here rather than at each call site.
 */
export function tidyBoxes(nodes: readonly SpatialNode[]): TidyNode[] {
  return nodes.map((node) => ({
    id: node.id,
    frame: isFrame(node),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  }))
}

/**
 * The boxes that move, and only those. A box with a non-finite coordinate is
 * left out of the board, as a box that is not there: one such frame would
 * otherwise leave the whole board unmoved.
 */
export function tidyNodes(nodes: readonly TidyNode[], options: TidyOptions): readonly TidyMove[] {
  const usable = nodes.filter((n) => isFiniteRect(n))
  if (usable.length < 2) return []
  const { scope, locked, edges } = options
  return queried<readonly TidyMove[]>(options.core, {
    request: () => ({
      query: 'tidy',
      nodes: usable.map((n) => [n.id, n.frame, n.x, n.y, n.width, n.height] as const),
      ...(scope === undefined ? {} : { scope: [...scope] }),
      locked: locked === undefined ? [] : usable.filter((n) => locked(n.id)).map((n) => n.id),
      ...(edges === undefined
        ? {}
        : { edges: edges.map((e) => [endNode(e.from) ?? null, endNode(e.to) ?? null] as const) }),
    }),
    unanswered: (refusal) => {
      options.onRefused?.(refusal)
      return []
    },
    // The core answers no move for a locked id; one that came back anyway is
    // dropped here, so no caller applies a move to a node that may not move.
    read: (answer) =>
      'moves' in answer
        ? answer.moves
            .filter((move) => locked?.(move[0]) !== true)
            .map((move) =>
              move.length === 3
                ? { id: move[0], x: move[1], y: move[2] }
                : { id: move[0], x: move[1], y: move[2], width: move[3], height: move[4] },
            )
        : undefined,
  })
}
