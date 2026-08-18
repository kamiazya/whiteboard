import type { DocumentInfo } from './types'

// Most recently updated first. Returns a new array; never mutates the input.
export function sortDocumentsByRecency(documents: readonly DocumentInfo[]): DocumentInfo[] {
  return [...documents].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

// Matches by path or by the caller-supplied display name, case-insensitively.
export function filterDocumentsBySearch(
  documents: readonly DocumentInfo[],
  query: string,
  namesByPath: Readonly<Record<string, string>>,
): DocumentInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...documents]
  return documents.filter((c) => {
    const n = namesByPath[c.path]
    return c.path.toLowerCase().includes(q) || (n?.toLowerCase().includes(q) ?? false)
  })
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
