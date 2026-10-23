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
  memoryScope?: string,
): {
  query: string
  setQuery: (next: string) => void
  hits: readonly DocumentSearchHit[] | null
  searchDegraded: boolean
  /** The query is typed and its answer has not landed — debounce plus flight. */
  pending: boolean
  /** Pending long enough to be worth saying so. */
  slow: boolean
  /** Workspace switch: results computed against the departed content. */
  resetResults: () => void
} {
  const [query, setQuery] = useRememberedQuery(memoryScope)
  const [hits, setHits] = useState<readonly DocumentSearchHit[] | null>(null)
  const [searchDegraded, setSearchDegraded] = useState(false)
  // The trimmed query the last answer (or refusal) was for. Pending is the
  // difference between it and what is typed, so a revision re-read of the
  // same query keeps showing the rows it has instead of flashing busy.
  const [settledFor, setSettledFor] = useState<string | null>(null)
  const [slow, setSlow] = useState(false)

  // Debounced, and the LATEST query decides: the cleanup marks a superseded
  // request stale rather than trusting arrival order.
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      setHits(null)
      setSearchDegraded(false)
      setSettledFor(null)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      source
        .searchDocuments(trimmed, SEARCH_LIMIT)
        .then((results) => {
          if (stale) return
          setHits(results)
          setSearchDegraded(false)
          setSettledFor(trimmed)
        })
        .catch(() => {
          if (stale) return
          setHits(null)
          setSearchDegraded(true)
          setSettledFor(trimmed)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // `revision` too: results computed against the old content can name a
    // document that has since been renamed or deleted, and a row that opens
    // nothing is worse than a slower answer.
  }, [query, source, revision])

  // SCOPE RESET — the panel's own scope-reset effect calls this; the marker
  // lets scoped-screen-state.test.ts verify the setters from here.
  const resetResults = useCallback(() => {
    setHits(null)
    setSearchDegraded(false)
    setSettledFor(null)
  }, [])

  const trimmedQuery = query.trim()
  const pending =
    trimmedQuery !== '' && !trimmedQuery.startsWith('#') && settledFor !== trimmedQuery

  useEffect(() => {
    if (!pending) {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), SLOW_SEARCH_MS)
    return () => clearTimeout(timer)
  }, [pending, trimmedQuery])

  return { query, setQuery, hits, searchDegraded, pending, slow, resetResults }
}
