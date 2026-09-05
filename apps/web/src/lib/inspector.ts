/**
 * What the document page's one inspector slot can show.
 *
 * One slot rather than a boolean per panel because that is how the header
 * reads: each opener is an `aria-pressed` / `aria-expanded` toggle, and two
 * pressed at once beside one editor was the phone screenshot that started
 * the header retune — a display popover, the comments sheet and the history
 * sheet all open together, each unaware of the others. A union is the
 * declared surface (`.claude/rules/coverage-ledger.md`): the next panel
 * that belongs beside the editor is a member here, not a fifth boolean.
 *
 * Every member is the same kind of thing — information ABOUT the open
 * document, read or written beside it: its frontmatter (`properties`, a
 * markdown document only), its conversations, the documents that link to it
 * (`connections`, a daemon keeper only), its history.
 */
export type InspectorKind = 'properties' | 'comments' | 'connections' | 'history'

/**
 * What the vessel calls each panel. The test id spellings are the ones the
 * panels carried before they shared a vessel, kept so every browser flow
 * that finds them by name keeps finding them.
 */
export const INSPECTOR_CHROME = {
  properties: { label: 'Properties', testId: 'properties-panel' },
  comments: { label: 'Comments', testId: 'comments-rail' },
  connections: { label: 'Connections', testId: 'connections-panel' },
  history: { label: 'History', testId: 'history-panel' },
} as const satisfies Record<InspectorKind, { label: string; testId: string }>
