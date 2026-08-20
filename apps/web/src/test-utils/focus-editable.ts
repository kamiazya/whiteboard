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
 * It takes a RESOLVER, not an element, and re-resolves on every retry. Under a
 * loaded run the contentDOM grabbed right after `render()` can be swapped
 * before the focus call, and `focus()` on a disconnected element is a spec'd
 * no-op — `document.activeElement` stays `<body>`, which is verbatim what CI
 * printed while the same file passed on any idle machine. A held element is a
 * snapshot; only re-resolving follows the swap.
 *
 * Use this only where the click exists to establish focus. A click on a
 * specific `.cm-line` also places the caret at that position, and replacing it
 * with `focus()` would move the caret to wherever CodeMirror last had it — a
 * different test.
 */
export async function focusEditable(resolveEditable: () => Element | null): Promise<void> {
  await vi.waitFor(() => {
    const element = resolveEditable()
    expect(element, 'no editable to focus').not.toBeNull()
    if (document.activeElement !== element) {
      ;(element as HTMLElement).focus()
    }
    expect(document.activeElement).toBe(element)
  })
}
