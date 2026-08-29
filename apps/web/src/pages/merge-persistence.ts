import type { BrowserPersistenceState } from './use-browser-document-controller.js'

/**
 * One indicator over the two writers a markdown document has.
 *
 * The controller persists renames and spatial content; the markdown body
 * keeps its own debounced save. They write the same document and share one
 * dot, so the dot has to answer for both.
 *
 * The rule follows from what the indicator promises — "your work is safe
 * here". It may only say that when BOTH writers agree, because the one that
 * is behind is precisely the one holding unsaved work. The page previously
 * showed the controller's state alone, which never moves for a body edit, so
 * the chip read `Saved` over text that had not been written: measured at
 * `saved / null / "Saved"` three seconds (six debounce periods) after typing.
 */

// Worst-first: a failure outranks work in flight, because the pending write
// may yet land while the failed one already did not, and that is the state a
// person needs to act on.
const SEVERITY: Record<BrowserPersistenceState['kind'], number> = {
  degraded: 3,
  saving: 2,
  pending: 2,
  saved: 1,
}

/** The later of two timestamps, treating absent as "never written". */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a > b ? a : b
}

export function mergePersistence(
  a: BrowserPersistenceState,
  b: BrowserPersistenceState,
): BrowserPersistenceState {
  const lastSavedAt = laterOf(a.lastSavedAt, b.lastSavedAt)
  // Ties go to `a` only after severity has decided, so `saving` vs `pending`
  // (equal severity) keeps whichever side the caller passed first — both are
  // "not settled yet", which is the only distinction the indicator draws.
  const worst = SEVERITY[b.kind] > SEVERITY[a.kind] ? b : a
  return { ...worst, lastSavedAt }
}
