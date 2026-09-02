/**
 * Waiting until a markdown body has actually been written to the store.
 *
 * `SaveStatusChip` publishes `data-save-state` and `data-last-saved-at`; the
 * accessible name says "Saved" for a document that has never been written
 * too, which is right for a reader and useless as proof for a test.
 *
 * The subtlety this helper exists for is one step past that. A settled
 * `saved` plus a present `data-last-saved-at` proves SOME write landed — not
 * that it covered what is currently on screen. Under load, typing outlasts
 * the 500ms debounce, so a partial body is written while the rest of the
 * keystrokes are still travelling
 * CodeMirror -> Loro commit -> doc subscription -> setBody -> `pending`.
 * That chain is asynchronous, so the editor can already show the full text
 * — all a caller can cheaply check — while the indicator is still describing
 * the partial write. A wait that samples once there returns immediately, the
 * test navigates away, and the remaining characters are never flushed.
 *
 * Observed as `expected '# From ' to contain '# From the list'`: seven of
 * fifteen characters, saved and settled, with the editor showing all
 * fifteen.
 *
 * So: settle, wait out a full debounce period, and settle again. Any edit
 * whose save had not yet been scheduled re-arms the indicator during that
 * window, and the second wait answers for it.
 */
import { waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import { SAVE_DEBOUNCE_MS } from '../pages/use-markdown-document.js'

/** How long to leave the indicator alone before believing it. */
const SETTLE_MS = SAVE_DEBOUNCE_MS * 2

function expectSettled(): string {
  const chip = document.querySelector('[data-testid="save-status-chip"]')
  expect(chip?.getAttribute('data-save-state')).toBe('saved')
  const at = chip?.getAttribute('data-last-saved-at')
  expect(at).toBeTruthy()
  return at as string
}

export interface WaitForSavedOptions {
  /**
   * When the caller finished typing, as `Date.now()`. Turns the wait from a
   * DURATION into a PROOF: the CodeMirror binding commits into the Loro doc
   * synchronously with the keystroke, and a write serialises the doc as it
   * stands when it RUNS — so a write that COMPLETED at or after this instant
   * necessarily contains every keystroke before it. The last edit's own
   * debounce guarantees such a write arrives, so the wait only has to be
   * patient rather than precisely timed.
   */
  readonly since?: number
  readonly timeout?: number
}

/**
 * Resolves once a write has landed that provably covers the caller's typing
 * (with `since`), or — without an anchor — once a write has landed and
 * nothing further was scheduled while we watched. Returns the
 * `data-last-saved-at` it settled on, so a caller that cares which write it
 * waited for can say so.
 *
 * The settle window below is the weaker of the two and is kept only for
 * callers with nothing to anchor on. It closes the window it was written for
 * and no more: a fixed duration cannot tell "finished" from "the delivery
 * that arms the next save has not arrived yet", and under a full browser
 * project the second is unbounded — measured elsewhere in this repo at 1.5s
 * alone versus 30-39s with every browser file in flight. That is the run
 * that failed CI on a partial body while the indicator sat, unchanged and
 * truthful, on the write before it.
 */
export async function waitForMarkdownSaved(
  options: WaitForSavedOptions | number = {},
): Promise<string> {
  const { since, timeout = 15_000 } =
    typeof options === 'number' ? { since: undefined, timeout: options } : options
  if (since !== undefined) {
    return await waitFor(
      () => {
        const at = expectSettled()
        expect(
          Date.parse(at) >= since,
          `the latest write (${at}) completed before the typing it must cover`,
        ).toBe(true)
        return at
      },
      { timeout },
    )
  }
  await waitFor(expectSettled, { timeout })
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  return await waitFor(expectSettled, { timeout })
}
