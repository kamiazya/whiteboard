/**
 * What the document page's one inspector slot can show.
 *
 * One slot rather than a boolean per panel because that is how the header
 * reads: each opener is an `aria-pressed` / `aria-expanded` toggle, and two
 * pressed at once beside one editor was the phone screenshot that started
 * the header retune — a display popover, the comments sheet and the history
 * sheet all open together, each unaware of the others. A union is the
 * declared surface (`.claude/rules/coverage-ledger.md`): the next panel
 * that belongs beside the editor is a member here, not a fourth boolean.
 */
export type InspectorKind = 'history' | 'comments'
