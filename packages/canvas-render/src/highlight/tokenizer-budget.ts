// What the tokeniser may still spend in ONE layout, across every fence it
// colours. The default highlighter prices each fence on its own
// (`lowlight.ts`), which bounds a fence and nothing more: a document of many
// fences, each just under that price, is tokenised fence by fence inside
// synchronous layout — measured at 63 fences of one 4095-character
// identifier, 1.06e9 squared characters and 6.3s for one render.
//
// Pure and free of the highlighter itself, so the layout's per-render account
// (`layout/nodes/embed-budget.ts`) can open one without importing a grammar.

/**
 * The running account. A counter rather than a value threaded functionally,
 * for the reason the nested-layout budget is one: sibling fences spend from
 * one pool, and a typesetter returning scene nodes has no channel to hand
 * back what is left.
 */
export interface TokenizerBudget {
  /** Squared identifier-run characters, the quantity js/ts/bash are quadratic in. */
  wordRunsRemaining: number
  /** Squared line characters, the quantity yaml is quadratic in. */
  lineRunsRemaining: number
  /**
   * Refusals so far, of anything this render's budget declined — so a cache
   * can tell a body this render degraded from one that is plain on its own.
   */
  refused: number
}

/**
 * Four fences at the per-fence word price (4096^2 each): about 0.4s of
 * typescript, the most expensive grammar, against 6.3s unbounded. Ordinary
 * code charges far less than its length suggests — 256 Ki characters of
 * ordinary typescript is about 2.9e6, under a twentieth of this — so a board
 * of real code highlights fully and only a document BUILT of near-limit
 * identifiers reaches it.
 */
const LAYOUT_WORD_RUN_BUDGET = 4 * 4096 * 4096

/** Four yaml fences at the per-fence line price (8192^2 each), on the same reasoning. */
const LAYOUT_LINE_RUN_BUDGET = 4 * 8192 * 8192

export function createTokenizerBudget(): TokenizerBudget {
  return {
    wordRunsRemaining: LAYOUT_WORD_RUN_BUDGET,
    lineRunsRemaining: LAYOUT_LINE_RUN_BUDGET,
    refused: 0,
  }
}

/**
 * Spends one fence's priced cost; `false` when either account cannot cover
 * it, and nothing is spent — so a cheaper fence after a refused one may
 * still be coloured, while the total never passes the budget.
 */
export function spendTokenizer(
  budget: TokenizerBudget,
  wordRuns: number,
  lineRuns: number,
): boolean {
  if (wordRuns > budget.wordRunsRemaining || lineRuns > budget.lineRunsRemaining) {
    budget.refused += 1
    return false
  }
  budget.wordRunsRemaining -= wordRuns
  budget.lineRunsRemaining -= lineRuns
  return true
}
