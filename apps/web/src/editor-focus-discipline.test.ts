// `userEvent.click` waits for its target to be "visible, enabled and stable".
// A CodeMirror editor in this app sits beside a preview pane that re-renders
// through real Canvas 2D text measurement, so under a saturated run the layout
// keeps settling and that check never passes: the test spends its whole budget
// on a precondition and never reaches what it asserts. Measured on one such
// test: 369ms idle, 60s in CI.
//
// Clicking a `.cm-line` is how that wait gets in. `focusEditable` does the same
// job without it — see `test-utils/focus-editable.ts`.
//
// The rule is precise rather than a judgement call: a click followed by an
// ABSOLUTE caret move (`Ctrl+Home` / `Ctrl+End`) is a focus click, because that
// move discards whatever position the click produced. All seven `.cm-line`
// clicks that existed when this guard was written turned out to be exactly
// that, so none of them was buying what it looked like it was buying.
//
// A test that genuinely needs the click's OWN position is a different case and
// this guard does not know how to tell them apart — say so with the escape
// comment on the line above and it will pass.
//
// Source is captured at build time via `?raw` rather than read at runtime, so
// this stays free of `node:fs` — apps/web is browser-only (see
// web-app-boundary.test.ts).

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('./**/*.browser.test.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Opt out on the line above the click, naming why the position is the point. */
const ESCAPE = 'cm-line-click-is-deliberate:'

// `.*` rather than `[^)]*`: the resolver is often a CALL
// (`editableOf().querySelector('.cm-line')`), and stopping at the first `)`
// silently skipped one of the seven this guard was written for.
const CLICK_ON_A_LINE = /userEvent\.click\(.*\.cm-line/

/**
 * The other way the caret gets into an editor without the helper: `focus()`
 * called on a node the test resolved earlier. Two shapes, one defect —
 * `focus()` on a detached or not-yet-mounted contentDOM is a no-op, and
 * whatever waits afterwards cannot recover because nothing re-attempts it.
 * `focusEditable` re-resolves AND re-focuses on every attempt.
 */
const RAW_FOCUS_ON_AN_EDITABLE = /\beditable[A-Za-z]*\s*(?:as HTMLElement\)?)?\s*\.focus\(\)/

describe('putting the caret in a CodeMirror editor from a browser test', () => {
  it('goes through focusEditable, not a .cm-line click or a bare focus()', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      const lines = source.split('\n')
      lines.forEach((line, i) => {
        if (!CLICK_ON_A_LINE.test(line) && !RAW_FOCUS_ON_AN_EDITABLE.test(line)) return
        const preceding = lines.slice(Math.max(0, i - 3), i).join('\n')
        if (preceding.includes(ESCAPE)) return
        offenders.push(`${path}:${i + 1}`)
      })
    }
    expect(
      offenders,
      `These put the caret in a CodeMirror editor without focusEditable — by clicking a ` +
        `.cm-line (which waits for the neighbouring preview to be "stable", and under load it ` +
        `never is) or by calling focus() on a node resolved earlier (a no-op if it is detached ` +
        `or not yet mounted, and nothing re-attempts it). Use focusEditable(resolver), and ` +
        `place the caret with an absolute move. If the click's own position IS the test, put a ` +
        `"${ESCAPE} <why>" comment above it.\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })
})
