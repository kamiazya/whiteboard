import type { CanvasInfo } from './types'

// Most recently updated first. Returns a new array; never mutates the input.
export function sortCanvasesByRecency(canvases: readonly CanvasInfo[]): CanvasInfo[] {
  return [...canvases].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

// Matches by slug or by the caller-supplied display name, case-insensitively.
export function filterCanvasesBySearch(
  canvases: readonly CanvasInfo[],
  query: string,
  namesBySlug: Readonly<Record<string, string>>,
): CanvasInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...canvases]
  return canvases.filter((c) => {
    const n = namesBySlug[c.slug]
    return c.slug.toLowerCase().includes(q) || (n?.toLowerCase().includes(q) ?? false)
  })
}

// Preserves the user-defined order in `pinnedSlugs` instead of resorting
// those items by recency. Slugs with no matching canvas are dropped.
export function derivePinnedCanvases(
  canvases: readonly CanvasInfo[],
  pinnedSlugs: readonly string[],
): CanvasInfo[] {
  const bySlug = new Map(canvases.map((c) => [c.slug, c]))
  return pinnedSlugs.map((s) => bySlug.get(s)).filter((c): c is CanvasInfo => !!c)
}

// Groups by slug prefix (the first "/"-delimited segment); canvases without
// a "/" land in the ungrouped bucket (empty-string key). Group headers sort
// alphabetically, with the ungrouped bucket always last. Canvases already
// present in `pinnedSlugs` are excluded so they are not shown twice.
export function groupCanvases(
  canvases: readonly CanvasInfo[],
  pinnedSlugs: ReadonlySet<string>,
): Array<[string, CanvasInfo[]]> {
  const groups = new Map<string, CanvasInfo[]>()
  const UNGROUPED = ''
  for (const c of canvases) {
    if (pinnedSlugs.has(c.slug)) continue
    const ix = c.slug.indexOf('/')
    const key = ix === -1 ? UNGROUPED : c.slug.slice(0, ix)
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
