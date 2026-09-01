import { useCallback, useEffect, useState } from 'react'
import type { DocumentSearchHit, WorkspaceFilesSource } from './files-source.js'

/** One screenful of results; the ranking makes a longer list noise. */
const SEARCH_LIMIT = 20
/** Long enough that typing a word is one search, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 150

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
): {
  query: string
  setQuery: (next: string) => void
  hits: readonly DocumentSearchHit[] | null
  searchDegraded: boolean
  /** Workspace switch: results computed against the departed content. */
  resetResults: () => void
} {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<readonly DocumentSearchHit[] | null>(null)
  const [searchDegraded, setSearchDegraded] = useState(false)

  // Debounced, and the LATEST query decides: a slower answer for a query
  // the user has already moved on from must never replace a newer one, so
  // the cleanup marks its own request stale rather than trusting arrival
  // order.
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      setHits(null)
      setSearchDegraded(false)
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
        })
        .catch(() => {
          if (stale) return
          setHits(null)
          setSearchDegraded(true)
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
  }, [])

  return { query, setQuery, hits, searchDegraded, resetResults }
}
