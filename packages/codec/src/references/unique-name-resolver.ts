/**
 * `[[Name]]` resolves iff exactly ONE document carries that display name.
 * Ambiguity resolves to null — the reference stays literal bracket text
 * (the codec's documented degradation) rather than a link that silently
 * guessed which "untitled" the author meant. Matching is exact: display
 * names are the author's own text, and case-folding or trimming here would
 * make a link resolve differently than the list the author can see.
 *
 * Lives in codec (not per consumer) because the READER and the reference
 * INDEX must resolve identically: a name the preview leaves as literal text
 * must never count as a backlink.
 */
import type { AliasResolver } from './resolve.js'

export interface UniqueNameEntry {
  readonly id: string
  readonly name: string
}

export function createUniqueNameResolver(entries: readonly UniqueNameEntry[]): AliasResolver {
  const byName = new Map<string, string | null>()
  for (const entry of entries) {
    const prev = byName.get(entry.name)
    // Uniqueness counts OWNERS, not claims: callers feed a path entry and a
    // name entry per document, so a document named exactly its own path is
    // one owner arriving twice — still a link, not an ambiguity.
    byName.set(entry.name, prev === undefined || prev === entry.id ? entry.id : null)
  }
  return (alias) => byName.get(alias) ?? null
}
