/**
 * Sizing and state tokens for the icon controls in the two chrome rows —
 * the AppShell row and the document's top bar.
 *
 * One spelling for the same reason `dock-button.ts` has one: a row assembled
 * from files that cannot see each other's intent ends up with one size per
 * file. Measured before this module: five spellings in one row (raw
 * `<button>` beside shadcn `Button`, `p-1` beside `p-1.5`, `size-7` beside
 * `size-8`, `rounded` beside `rounded-md`, a 14px glyph beside 16px ones),
 * and NO `pointer-coarse` step anywhere in the header while the dock had
 * one — so on a phone the top and bottom of the same screen answered the
 * finger differently. `header-button-surface.test.ts` holds the row to this
 * module from both sides.
 *
 * 32px on a fine pointer, 44px on a coarse one — the same two sizes and the
 * same reason as the dock: 44px is the touch-target floor, and it fits a
 * 48px row. Deliberately NOT the dock's constants themselves: the dock is a
 * tool row and answers a press with `active:scale`; a header control opens
 * something beside the document and stays put.
 *
 * The toggle variants compose `TOGGLE_STATE_CLASS`, so a control that wears
 * one derives its on-state from `aria-pressed` / `aria-expanded` — the rule
 * DESIGN.md states and `toggle-state-surface.test.ts` enforces, which also
 * finds these constants by scanning rather than by name.
 */

import { TOGGLE_STATE_CLASS } from './dock-button.js'

const HEADER_BUTTON_BASE_CLASS =
  'inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color] duration-(--motion-duration-fast) ease-(--motion-ease-out) hover:bg-accent hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Height apart from width because one control is legitimately not square:
 * the comments opener carries its open-thread count beside the glyph.
 */
const HEADER_BUTTON_HEIGHT_CLASS = 'h-8 pointer-coarse:h-11'

/** A square header control (icon only). */
export const HEADER_BUTTON_CLASS = `${HEADER_BUTTON_BASE_CLASS} ${HEADER_BUTTON_HEIGHT_CLASS} w-8 pointer-coarse:w-11`

/** A header control whose content sets its width (icon plus a count). */
const HEADER_WIDE_BUTTON_CLASS = `${HEADER_BUTTON_BASE_CLASS} ${HEADER_BUTTON_HEIGHT_CLASS} min-w-8 gap-1 px-1.5 pointer-coarse:min-w-11`

/** `HEADER_BUTTON_CLASS` for a control that opens something and must look open. */
export const HEADER_TOGGLE_CLASS = `${HEADER_BUTTON_CLASS} ${TOGGLE_STATE_CLASS}`

/** `HEADER_WIDE_BUTTON_CLASS` for a control that opens something and must look open. */
export const HEADER_WIDE_TOGGLE_CLASS = `${HEADER_WIDE_BUTTON_CLASS} ${TOGGLE_STATE_CLASS}`
