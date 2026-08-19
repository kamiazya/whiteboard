import type { DocumentInfo } from './types'

// Most recently updated first. Returns a new array; never mutates the input.
export function sortDocumentsByRecency(documents: readonly DocumentInfo[]): DocumentInfo[] {
  return [...documents].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

/**
 * The one rule for "does this document match what was typed": its path or
 * its display name contains the query, case-insensitively.
 *
 * Exported so the document browser can apply it to its own row shape, which
 * carries the name inline instead of in a side table. Two matchers would be
 * two searches that disagree about the same query.
 *
 * An empty query matches everything — callers decide whether that means
 * "show all" or "not searching".
 */
export function documentMatchesSearch(
  query: string,
  document: { readonly path: string; readonly name?: string | undefined },
): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return (
    document.path.toLowerCase().includes(q) || (document.name?.toLowerCase().includes(q) ?? false)
  )
}

// Matches by path or by the caller-supplied display name, case-insensitively.
export function filterDocumentsBySearch(
  documents: readonly DocumentInfo[],
  query: string,
  namesByPath: Readonly<Record<string, string>>,
): DocumentInfo[] {
  if (query.trim() === '') return [...documents]
  // Either source, though today neither caller can tell them apart:
  // DocumentListView builds its table from `r.displayName` on the line above
  // the rows themselves, and useDocumentNames builds local-mode's from
  // `c.name`. So this `??` is the function's contract matching its own
  // signature — it takes rows that carry a name AND a table of names — and
  // not a live defect. A caller that populated only one would otherwise
  // search by path alone with nothing to say so.
  return documents.filter((c) =>
    documentMatchesSearch(query, { path: c.path, name: namesByPath[c.path] ?? c.name }),
  )
}

// Preserves the user-defined order in `pinnedPaths` instead of resorting
// those items by recency. Paths with no matching canvas are dropped.
export function derivePinnedCanvases(
  documents: readonly DocumentInfo[],
  pinnedPaths: readonly string[],
): DocumentInfo[] {
  const byPath = new Map(documents.map((c) => [c.path, c]))
  return pinnedPaths.map((s) => byPath.get(s)).filter((c): c is DocumentInfo => !!c)
}

// Groups by path prefix (the first "/"-delimited segment); documents without
// a "/" land in the ungrouped bucket (empty-string key). Group headers sort
// alphabetically, with the ungrouped bucket always last. Documents already
// present in `pinnedPaths` are excluded so they are not shown twice.
export function groupCanvases(
  documents: readonly DocumentInfo[],
  pinnedPaths: ReadonlySet<string>,
): Array<[string, DocumentInfo[]]> {
  const groups = new Map<string, DocumentInfo[]>()
  const UNGROUPED = ''
  for (const c of documents) {
    if (pinnedPaths.has(c.path)) continue
    const ix = c.path.indexOf('/')
    const key = ix === -1 ? UNGROUPED : c.path.slice(0, ix)
    const arr = groups.get(key)
    if (arr) arr.push(c)
    else groups.set(key, [c])
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNGROUPED) return 1
    if (b === UNGROUPED) return -1
    return a.localeCompare(b)
  })
}
