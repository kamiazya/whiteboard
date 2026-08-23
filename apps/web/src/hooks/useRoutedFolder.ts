import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

const FOLDER_PARAM = 'folder'

/**
 * The document browser's open folder, kept in the address.
 *
 * It belongs there because it is WHAT YOU ARE LOOKING AT: a link to a folder
 * should open that folder, a reload should not drop you at the workspace
 * root, and creating a document can open it without the trip back costing
 * you your place. The column layout deliberately stays out — that is HOW you
 * look, a per-device preference, and a shared link must not impose the
 * sender's layout on whoever opens it.
 *
 * A query parameter rather than a path segment, because it is a position
 * WITHIN a page rather than a different page. That also keeps it invisible
 * to `App.tsx`'s two route-sync effects, which compare `location.pathname`
 * and would otherwise fight this for the URL.
 *
 * `replace`, never push: the panel holds this as its own state seeded from
 * here, so it cannot follow a Back that changes only the query string. A URL
 * the UI silently disagrees with is worse than no folder in the URL at all,
 * and Back keeps meaning "leave the browser" — which is what it means today.
 */
export function useRoutedFolder(): {
  folder: string
  setFolder: (folder: string) => void
} {
  const [searchParams, setSearchParams] = useSearchParams()

  const setFolder = useCallback(
    (folder: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (folder === '') next.delete(FOLDER_PARAM)
          else next.set(FOLDER_PARAM, folder)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  return { folder: searchParams.get(FOLDER_PARAM) ?? '', setFolder }
}
