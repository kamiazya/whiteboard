import { waitFor } from '@testing-library/react'
import { expect } from 'vitest'

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

/**
 * Waits for the editor to HOLD what the test typed, before anything waits on
 * what the preview draws from it.
 *
 * The embed tests below fail on CI with the preview reading the embed's
 * LABEL and never its body — and a lone `![[target]]` followed by a single
 * newline (or none) renders exactly that: an INLINE embed draws its label
 * and no body, so no amount of waiting on the load delivers one. Measured:
 * `![[ID]]\n\nand more typing` lays out the body, `![[ID]]\nand more typing`
 * lays out `Embed target and more typing`, which is the failure's text. So
 * "the body never arrived" was two failures sharing one message — the
 * source missing its blank line, or the source right and the render wrong —
 * and this check is what tells them apart from a single CI log, since the
 * failure's DOM dump is truncated before it reaches the editor.
 *
 * Reads CodeMirror's rendered lines, so it holds for a document short enough
 * to be drawn whole — which every test typing into an empty editor is.
 */
export async function expectTypedSource(expected: string): Promise<void> {
  await waitForOrSayWhen(
    () => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')].map(
        (line) => line.textContent ?? '',
      )
      expect(lines.join('\n')).toBe(expected)
    },
    { budgetMs: 10_000, subject: 'the typed source' },
  )
}
