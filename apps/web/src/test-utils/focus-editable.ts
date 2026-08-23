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
 * Use this where the caret's position is not what the click was for. The rule
 * is precise rather than a judgement call: **a click followed by an absolute
 * caret move is a focus click**, because `Ctrl+Home` / `Ctrl+End` discards
 * whatever position either the click or `focus()` produced. Only a test that
 * reads the click's OWN position — one that does not immediately move the
 * caret somewhere absolute — is a different test after the swap.
 *
 * That distinction was worth measuring rather than assuming. Every one of the
 * seven `.cm-line` clicks left in this repo turned out to discard its own
 * caret on the very next keystroke, so all seven converted without changing
 * what they assert. Two of them wrote `{Home}` (start of the CURRENT line)
 * and relied on the click having landed on the first line by hit-testing;
 * those became `{Control>}{Home}{/Control}`, which states the same intent and
 * cannot be moved by layout.
 *
 * Everything below is re-done on EVERY attempt, because each step can be
 * invalidated between attempts by state this test does not own:
 *
 * - It takes a RESOLVER, not an element. A node grabbed right after `render()`
 *   is a snapshot; under load the contentDOM lands late or is swapped, and
 *   `focus()` on a disconnected element is a spec'd no-op. Only re-resolving
 *   follows the swap — an element held by value is the repo's sixth flake
 *   shape wearing a helper.
 * - `window.focus()` before the element focus. Several browser pages run in
 *   parallel and only ONE can hold focus; measured in CI, the failing case is
 *   `document.hasFocus()=false`, and an element in an unfocused document
 *   cannot become its activeElement however many times focus() is called.
 * - An unrendered editable is named outright: the source pane is display:none
 *   whenever the editor is in Read mode, `focus()` on an element that is not
 *   being rendered is a no-op, and "activeElement is <body>" says nothing
 *   about why. Seeding the shared view-mode preference to 'read' reproduces a
 *   whole file of those verbatim — see `initialViewMode` on MarkdownEditor.
 */
export async function focusEditable(resolveEditable: () => Element | null): Promise<void> {
  await vi.waitFor(() => {
    const element = resolveEditable()
    expect(
      element,
      'focusEditable: the resolver answered null — no editable in the DOM',
    ).not.toBeNull()
    if (!(element as Element).isConnected) {
      // A resolver that answers a detached node is frozen over a captured
      // reference — retrying cannot help, so say so instead of spending the
      // budget.
      throw new Error(
        'focusEditable: the resolver answered a node that is no longer in the document — ' +
          'resolve from the live DOM, not a captured reference.',
      )
    }
    expect(
      (element as HTMLElement).checkVisibility(),
      'focusEditable: editable is not rendered (display:none — is the editor in Read mode?)',
    ).toBe(true)
    window.focus()
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
