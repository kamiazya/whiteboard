import type { AliasResolver } from '@kamiazya/whiteboard-canvas-codec'

export interface AliasResolverEntry {
  readonly id: string
  readonly name: string
}

/**
 * Builds canvas-codec's `AliasResolver` from a canvas snapshot list:
 * `[[Name]]` resolves iff exactly ONE canvas carries that display name.
 * Ambiguity resolves to null — the reference stays literal bracket text
 * (the codec's documented degradation) rather than a link that silently
 * guessed which "untitled" the author meant. Matching is exact: display
 * names are the author's own text, and case-folding or trimming here would
 * make a link resolve differently than the list the author can see.
 */
export function createSnapshotAliasResolver(entries: readonly AliasResolverEntry[]): AliasResolver {
  const byName = new Map<string, string | null>()
  for (const entry of entries) {
    byName.set(entry.name, byName.has(entry.name) ? null : entry.id)
  }
  return (alias) => byName.get(alias) ?? null
}
