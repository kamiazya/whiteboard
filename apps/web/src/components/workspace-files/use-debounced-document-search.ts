import { useCallback, useEffect, useState } from 'react'
import type { DocumentSearchHit, WorkspaceFilesSource } from '../../lib/files-source.js'
import { recallSearchQuery, rememberSearchQuery } from '../../lib/search-query-memory.js'

/** One screenful of results; the ranking makes a longer list noise. */
const SEARCH_LIMIT = 20
/** Long enough that typing a word is one search, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 150
/** A wait shorter than this is a blink; saying "Searching…" for it is flicker. */
const SLOW_SEARCH_MS = 300

/** The box's text, refilled from the scope's memory when the panel mounts again. */
function useRememberedQuery(memoryScope: string | undefined) {
  const [query, setQueryState] = useState(() => recallSearchQuery(memoryScope))
  const setQuery = useCallback(
    (next: string) => {
      rememberSearchQuery(memoryScope, next)
      setQueryState(next)
    },
    [memoryScope],
  )
  return [query, setQuery] as const
}

/** What the panel needs to draw a search: the rows, why they may be narrow, whether more is coming. */
export interface SearchState {
  hits: readonly DocumentSearchHit[] | null
  searchDegraded: boolean
  searching: 'idle' | 'waiting' | 'slow'
}

/**
 * The panel's content search against its source, debounced.
 *
 * Search results come from the SOURCE — the content it can read is the whole
 * point, and no filter over the loaded list can see a body. `searchDegraded`
 * is true when the content search could not be reached (an older daemon
 * without the route, or a network that said no); the panel then answers from
 * the list it already holds and SAYS that it did, because a quietly narrower
 * answer is indistinguishable from a document that is not there.
 */
export function useDebouncedDocumentSearch(
  source: Pick<WorkspaceFilesSource, 'searchDocuments'>,
  /** See WorkspaceFilesPanelProps.revision — content may change behind the panel. */
  revision: unknown,
  /** The scope whose remembered query refills the box; none keeps the box empty. */
  memoryScope?: string,
): {
  query: string
  setQuery: (next: string) => void
  search: SearchState
  /** Workspace switch: results computed against the departed content. */
  resetResults: () => void
} {
  const [query, setQuery] = useRememberedQuery(memoryScope)
  // The last answer and the trimmed query it was for. Pending is the
  // difference between that query and what is typed, so a revision re-read of
  // the same query keeps showing its rows instead of flashing busy.
  const [answer, setAnswer] = useState<{
    forQuery: string
    hits: readonly DocumentSearchHit[] | null
  } | null>(null)
  const trimmed = query.trim()
  const searchable = trimmed !== '' && !trimmed.startsWith('#')

  // Debounced, and the LATEST query decides: a slower answer for a query
  // the user has already moved on from must never replace a newer one, so
  // the cleanup marks its own request stale rather than trusting arrival
  // order.
  useEffect(() => {
    if (!searchable) {
      setAnswer(null)
      return
    }
    let stale = false
    const settle = (hits: readonly DocumentSearchHit[] | null) => {
      if (!stale) setAnswer({ forQuery: trimmed, hits })
    }
    const timer = setTimeout(() => {
      source.searchDocuments(trimmed, SEARCH_LIMIT).then(settle, () => settle(null))
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // `revision` too: results computed against the old content can name a
    // document that has since been renamed or deleted, and a row that opens
    // nothing is worse than a slower answer.
  }, [searchable, trimmed, source, revision])

  // SCOPE RESET — the panel's own scope-reset effect calls this; the marker
  // lets scoped-screen-state.test.ts verify the setters from here.
  const resetResults = useCallback(() => setAnswer(null), [])

  const waiting = searchable && answer?.forQuery !== trimmed
  const slow = useAfter(waiting, SLOW_SEARCH_MS)
  const searching = waiting ? (slow ? 'slow' : 'waiting') : 'idle'
  // A refused content search settles with null hits; null for an unsettled
  // query is just not-yet.
  const search: SearchState = {
    hits: answer?.hits ?? null,
    searchDegraded: answer?.hits === null,
    searching,
  }

  return { query, setQuery, search, resetResults }
}

/** Whether `active` has held for `ms` — a wait shorter than that is not worth saying. */
function useAfter(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!active) {
      setElapsed(false)
      return
    }
    const timer = setTimeout(() => setElapsed(true), ms)
    return () => clearTimeout(timer)
  }, [active, ms])
  return elapsed
}
