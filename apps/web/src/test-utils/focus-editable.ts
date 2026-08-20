import { expect, vi } from 'vitest'

/**
 * Put the caret in a CodeMirror editor so the next `userEvent.keyboard` lands
 * in it — WITHOUT clicking.
 *
 * `userEvent.click` waits for its target to be "visible, enabled and stable",
 * and a markdown editor is beside a preview pane that re-renders through real
 * Canvas 2D text measurement. Under a saturated run the layout keeps settling
 * and that actionability check never passes, so the test spends its entire 60s
 * budget waiting rather than failing on anything it asserts. Measured: one such
 * test costs 369ms idle and timed out at 60s in CI, a 160x gap that contention
 * alone does not explain — it is a wait for a condition, not a slow pass.
 *
 * Exact contentDOM identity is what real keyboard-event delivery depends on,
 * so this waits for `document.activeElement` to BE the element rather than to
 * contain it: focus sitting on an ancestor drops the keystrokes silently.
 *
 * Use this only where the click exists to establish focus. A click on a
 * specific `.cm-line` also places the caret at that position, and replacing it
 * with `focus()` would move the caret to wherever CodeMirror last had it — a
 * different test.
 */
export async function focusEditable(element: Element): Promise<void> {
  // focus() INSIDE the retry, not once before it. CodeMirror's contentDOM is
  // not focusable until the view has finished mounting, and a `focus()` that
  // lands before then is a silent no-op — so calling it once and then merely
  // WAITING can never recover: the wait re-checks a condition nothing is
  // still trying to satisfy. Locally the view is ready and the first call
  // takes; in CI it is not, and a whole file failed with
  // `expected <body> to be <div spellcheck="false" …>` — this assertion,
  // reporting that focus never moved.
  await vi.waitFor(() => {
    ;(element as HTMLElement).focus()
    expect(document.activeElement).toBe(element)
  })
}
