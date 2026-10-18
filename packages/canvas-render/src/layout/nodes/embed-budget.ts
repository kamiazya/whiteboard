import {
  CANVAS_MAX_EDGES_AND_LINES,
  CANVAS_MAX_NODES,
  type SpatialCanvas,
} from '@kamiazya/whiteboard-model'

/**
 * How many NESTED documents one render may lay out, across every embed kind:
 * a file node's canvas miniature and a markdown body's `![[…]]` block alike.
 *
 * The depth cap bounds how DEEP an embed goes, not how wide. Under a cap of
 * three, a canvas of k file nodes each embedding a canvas of k file nodes
 * costs k + k² + k³ layouts — measured at k = 12 across a four-level
 * fan-out, one render did not finish in ten minutes. A budget makes the cost
 * linear in the budget whatever the shape: at most this many nested layouts,
 * each bounded by the document it lays out.
 *
 * 128 because what a reader can use is far below it. A miniature at depth two
 * is already a thumbnail of a thumbnail, so the embeds worth drawing are
 * essentially the first level of a hub board — and a hub of more than a
 * hundred previewed documents is beyond any board this product has met. Past
 * the budget an embed degrades exactly as past the depth cap: a file node
 * draws its card, a body's embed its placeholder. The budget is spent depth
 * first in document order, so it is the LAST embeds of a large board that
 * degrade, never the first ones a reader sees.
 */
export const NESTED_LAYOUT_BUDGET = 128

/**
 * How many canvas ELEMENTS — nodes, edges and lines — the nested canvases of
 * one render may lay out between them.
 *
 * The layout count alone does not bound cost, because one layout is priced by
 * the board it lays out: 128 file nodes naming one maximal board laid that
 * board out 128 times, about seven seconds each on the daemon's measurer
 * (`mcp-server/scripts/measure/nested-embed-cost.mjs`). One maximal board's
 * worth — `CANVAS_MAX_NODES + CANVAS_MAX_EDGES_AND_LINES` — caps the nested work at
 * about one more top-level render, whatever the fan-out, while any board a
 * canvas may hold — lines included, since they share the edge ceiling —
 * still fits as a single miniature. An embed whose canvas would overdraw it degrades exactly as one
 * past the count does, and spends nothing, so a smaller embed after it may
 * still draw.
 */
export const NESTED_ELEMENT_BUDGET = CANVAS_MAX_NODES + CANVAS_MAX_EDGES_AND_LINES

/**
 * The budget's running account for ONE top-level render. A counter rather
 * than a value threaded functionally, because sibling embeds spend from one
 * pool and a recursion returning scenes has no channel to hand back what is
 * left. Created by each entry point and shared by every nesting level below
 * it — across the canvas/markdown boundary too, so neither kind of embed can
 * be used to spend around it.
 */
export interface NestedLayoutBudget {
  remaining: number
  elementsRemaining: number
  /** Embeds refused so far, so a cache can tell a body this render degraded. */
  refused: number
}

export function createNestedLayoutBudget(): NestedLayoutBudget {
  return { remaining: NESTED_LAYOUT_BUDGET, elementsRemaining: NESTED_ELEMENT_BUDGET, refused: 0 }
}

/** What a nested canvas charges the element budget: everything it lays out; a body, 0. */
export function canvasElementCount(canvas: SpatialCanvas | undefined): number {
  if (canvas === undefined) return 0
  return canvas.nodes.length + canvas.edges.length + (canvas.lines?.length ?? 0)
}

/**
 * Spends one nested layout of `elements` canvas elements;
 * `false` when either account cannot cover it, and nothing is spent.
 */
export function spendNestedLayout(budget: NestedLayoutBudget, elements: number): boolean {
  if (budget.remaining <= 0 || elements > budget.elementsRemaining) {
    budget.refused += 1
    return false
  }
  budget.remaining -= 1
  budget.elementsRemaining -= elements
  return true
}
