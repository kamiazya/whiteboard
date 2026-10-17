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
 * The budget's running account for ONE top-level render. A counter rather
 * than a value threaded functionally, because sibling embeds spend from one
 * pool and a recursion returning scenes has no channel to hand back what is
 * left. Created by each entry point and shared by every nesting level below
 * it — across the canvas/markdown boundary too, so neither kind of embed can
 * be used to spend around it.
 */
export interface NestedLayoutBudget {
  remaining: number
}

export function createNestedLayoutBudget(): NestedLayoutBudget {
  return { remaining: NESTED_LAYOUT_BUDGET }
}

/** Spends one nested layout; `false` when none is left, and nothing is spent. */
export function spendNestedLayout(budget: NestedLayoutBudget): boolean {
  if (budget.remaining <= 0) return false
  budget.remaining -= 1
  return true
}
