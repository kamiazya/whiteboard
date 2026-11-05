/**
 * The document the list last opened, so returning to the list can give focus
 * back to its row rather than starting the person over at the heading.
 *
 * Module state on purpose: the list unmounts while the document is open, and
 * the answer is wanted only within this tab's visit — a reload starts at the
 * heading, as an arrival should.
 */
let departedFrom: string | null = null

/** The list is opening the document at `path`. */
export function noteListDeparture(path: string): void {
  departedFrom = path
}

/** The path the list last opened, if it has not been returned to yet. */
export function listDeparture(): string | null {
  return departedFrom
}

/**
 * The return has happened — focus went back to the card, or the person moved
 * on first — so a later arrival starts at the heading. Kept apart from the
 * read because a development build runs an effect twice, and a read that
 * cleared would leave the second run nothing.
 */
export function settleListDeparture(path: string): void {
  if (departedFrom === path) departedFrom = null
}
