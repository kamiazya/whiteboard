/**
 * Whether the browser keeper is keeping — the one judgement the shell mark
 * draws for a browser-kept document.
 *
 * The persistence FACTS (`BrowserPersistenceState`) say the document is
 * unsaved for a few hundred milliseconds after every keystroke. That is the
 * ordinary state while someone types, asks nothing of them, and is not
 * shown. What is shown is a condition: an edit that has stayed unsaved for
 * longer than any write should take (`stuck`), or a write the store refused
 * (`failed`). `ok` is everything else, and `ok` draws nothing.
 */
import type { BrowserPersistenceState } from './browser-persistence-state.js'

export type StorageHealth = 'ok' | 'stuck' | 'failed'

/**
 * How long an edit may stay unsaved before that is a condition. An IndexedDB
 * write lands in tens of milliseconds and the debounce ahead of it is 500ms
 * at most, so five seconds is not a slow write — it is a write that is not
 * happening. Short enough to notice before leaving; long enough that a busy
 * page never trips it.
 */
export const STUCK_AFTER_MS = 5_000

/**
 * @param unsavedSince when the document last BECAME unsaved (the transition
 *   out of `saved`), or null when the caller has not seen one. A pending
 *   state with no known start is `ok`: there is nothing to count from, and
 *   a page that mounted mid-write must not open on a condition.
 */
export function storageHealthOf(
  state: BrowserPersistenceState,
  unsavedSince: number | null,
  now: number,
): StorageHealth {
  if (state.kind === 'degraded') return 'failed'
  if (state.kind === 'saved') return 'ok'
  if (unsavedSince === null) return 'ok'
  return now - unsavedSince >= STUCK_AFTER_MS ? 'stuck' : 'ok'
}
