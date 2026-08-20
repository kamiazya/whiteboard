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
 *
 * `focus()` is re-issued on EVERY attempt rather than once before the wait.
 * Focus is shared mutable state across a whole browser project: a neighbour's
 * leftover keystrokes, or its still-settling layout, can take it back after
 * the call and before it settles, and waiting alone never gets it back. And a
 * detached node is reported by name — it can never take focus, so waiting is
 * the one thing that cannot help, and "activeElement is <body>" says nothing
 * about which of the two happened. That message is what a whole file of
 * failures looked like in CI, eleven times, with no way to tell them apart.
 */
export async function focusEditable(element: Element): Promise<void> {
  await vi.waitFor(() => {
    // focus() INSIDE the retry, not once before it. CodeMirror's contentDOM is
    // not focusable until the view has finished mounting, and a `focus()` that
    // lands before then is a silent no-op — so calling it once and then merely
    // WAITING can never recover: the wait re-checks a condition nothing is
    // still trying to satisfy. Locally the view is ready and the first call
    // takes; in CI it is not, and a whole file failed with
    // `expected <body> to be <div spellcheck="false" …>` — this assertion,
    // reporting that focus never moved.
    //
    // A detached node is called out rather than waited on: it can never take
    // focus, so the retry is the one thing that cannot help it, and the
    // assertion below cannot tell that case apart from the not-yet-mounted
    // one. "activeElement is <body>" is equally what a reference held across
    // a re-render looks like, which is a different fix at a different place.
    if (!element.isConnected) {
      throw new Error(
        'focusEditable: the editable is no longer in the document — it was replaced between ' +
          'being queried and being focused. Re-query it inside the step that focuses it.',
      )
    }
    ;(element as HTMLElement).focus()
    // The message carries what DID have focus, and whether the document had
    // any: three different causes reached this line in CI and none of them was
    // distinguishable from the others.
    expect(
      document.activeElement,
      `focusEditable: focus did not land. document.hasFocus()=${document.hasFocus()}, ` +
        `activeElement=<${document.activeElement?.tagName.toLowerCase() ?? 'none'}${
          document.activeElement instanceof HTMLElement && document.activeElement.className !== ''
            ? ` class="${document.activeElement.className}"`
            : ''
        }>`,
    ).toBe(element)
  })
}
