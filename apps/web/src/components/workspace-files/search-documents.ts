/**
 * Finding a document by name, from anywhere in the workspace.
 *
 * Deliberately not scoped to the open folder. Searching is what someone does
 * when they do NOT know where a document is; a search that only looked where
 * they were standing would answer the one question they could already
 * answer by looking.
 *
 * An empty query answers nothing rather than everything. The caller shows
 * the folder's own contents in that case, and returning the whole workspace
 * here would put that decision in two places.
 */

import { compareDocumentEntries, type WorkspaceDocumentEntry } from './document-entry.js'

/**
 * Whether one document answers a query. Lived beside the editor header's
 * switcher until that switcher was retired; the browser's search is the only
 * caller left, so it lives here now.
 */
export function documentMatchesSearch(
  query: string,
  document: {
    readonly path: string
    readonly name?: string | undefined
    readonly tags?: readonly string[] | undefined
  },
): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  // `#tag` is a FILTER, not a search: it matches only documents carrying
  // exactly that tag, never a path or name that happens to contain the
  // word — clicking a tag chip must select the tag's carriers and nothing
  // else. Exact rather than substring for the same reason: `#q` naming no
  // tag selects nothing, instead of quietly widening to every q-ish tag.
  if (q.startsWith('#')) {
    const wanted = q.slice(1)
    if (wanted === '') return true
    return document.tags?.some((tag) => tag.toLowerCase() === wanted) ?? false
  }
  return (
    document.path.toLowerCase().includes(q) ||
    (document.name?.toLowerCase().includes(q) ?? false) ||
    (document.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false)
  )
}

export function searchDocuments<T extends WorkspaceDocumentEntry>(
  documents: readonly T[],
  query: string,
): readonly T[] {
  if (query.trim() === '') return []
  return documents
    .filter((entry) => documentMatchesSearch(query, entry))
    .sort(compareDocumentEntries)
}
