/**
 * The row the list last left for a document, so returning to the list can
 * give focus back to it rather than starting the person over at the heading.
 * That row is the one the person was ON: the card, tree row or search result
 * they opened, the Recent tile (a second row for the same document, which
 * is why the surface is kept), or — for a link followed in the preview —
 * the card of the document holding the link.
 *
 * Module state on purpose: the list unmounts while the document is open, and
 * the answer is wanted only within this tab's visit — a reload starts at the
 * heading, as an arrival should.
 */
export type ListSurface = 'list' | 'recent'

export interface ListDeparture {
  readonly path: string
  readonly surface: ListSurface
}

let departedFrom: ListDeparture | null = null

/** The list is leaving from the row for `path`, on `surface`. */
export function noteListDeparture(path: string, surface: ListSurface = 'list'): void {
  departedFrom = { path, surface }
}

/** The row the list last left from, if it has not been returned to yet. */
export function listDeparture(): ListDeparture | null {
  return departedFrom
}

/**
 * The return has happened — focus went back to the row, or the person moved
 * on first — so a later arrival starts at the heading. Kept apart from the
 * read because a development build runs an effect twice, and a read that
 * cleared would leave the second run nothing.
 */
export function settleListDeparture(path: string): void {
  if (departedFrom?.path === path) departedFrom = null
}
