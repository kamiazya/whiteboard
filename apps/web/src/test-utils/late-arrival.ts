import { waitFor } from '@testing-library/react'

/**
 * Wait for `assert` under a budget, and when the budget expires KEEP
 * WATCHING for a grace period before failing — so the failure says whether
 * the thing arrived late, and by how much, or never arrived at all.
 *
 * A `waitFor` that expires reports only that it expired. That cannot
 * distinguish "still loading" from "loaded and rendered nothing", and those
 * two have opposite fixes: the first is a budget or a cost question, the
 * second is a correctness bug. Distinguishing them has cost this repo a
 * measured investigation per occurrence — three hypotheses on the
 * `![[canvas#Group]]` embed preview, two refuted, and the survivor needed
 * exactly this distinction to be settled
 * (`issues/group-embed-preview-waitfor-budget`).
 *
 * The test still FAILS either way. Only what it says changes, which is the
 * point: a flake that reports which of two causes it was is a flake somebody
 * can fix from one CI log instead of from a reproduction nobody has.
 */
export async function waitForOrSayWhen(
  assert: () => void | Promise<void>,
  options: { readonly budgetMs: number; readonly graceMs?: number; readonly subject: string },
): Promise<void> {
  try {
    await waitFor(assert, { timeout: options.budgetMs })
    return
  } catch (expired) {
    const graceMs = options.graceMs ?? options.budgetMs * 3
    const startedWatchingAgain = performance.now()
    const lateBy = await waitFor(assert, { timeout: graceMs }).then(
      () => performance.now() - startedWatchingAgain,
      () => null,
    )
    if (lateBy === null) {
      throw new Error(
        `${options.subject} did not arrive within ${options.budgetMs}ms, and had still not arrived ${graceMs}ms later — so this is not the budget. What the wait last saw:\n${String(expired)}`,
      )
    }
    throw new Error(
      `${options.subject} arrived ${Math.round(lateBy)}ms AFTER its ${options.budgetMs}ms budget expired — it was still in flight, not missing. What the wait saw when it gave up:\n${String(expired)}`,
    )
  }
}
