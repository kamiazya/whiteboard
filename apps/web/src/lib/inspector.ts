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
 * The order the four read IN — the header's segment, left to right.
 *
 * Declared here rather than left to the render site because it is the one
 * thing a document KIND must not decide: before the segment existed, a
 * canvas drew `comments, kebab, history` and a note drew `properties,
 * comments, kebab`, each row assembled from whichever file happened to own
 * the opener. `inspector-order.test.ts` holds it to exactly the members of
 * `InspectorKind`, so a fifth panel takes a place here rather than landing
 * wherever its component is mounted.
 *
 * Properties first: ADR-0006 puts an object's properties ahead of its
 * verbs, and the rest run outward from the document — its own frontmatter,
 * the talk about it, what points at it, what it was.
 */
export const INSPECTOR_ORDER = [
  'properties',
  'comments',
  'connections',
  'history',
] as const satisfies readonly InspectorKind[]

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
