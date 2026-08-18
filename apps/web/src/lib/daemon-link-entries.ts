import type { DocumentSummary } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { AliasResolverEntry } from '../components/markdown-editor/alias-resolver.js'
import type { LinkTarget } from '../components/markdown-editor/link-target.js'

/**
 * A daemon document has two names and they are not interchangeable. The
 * `path` is its address — auto-generated (`untitled-2`), ASCII-only, and
 * what a URL and a rename-following link key on. The `displayName` is the
 * only identifier the user ever chose, and the only one the UI shows.
 *
 * `id` is optional on the summary because an older daemon omits it; the
 * path stands in, exactly as every other consumer of this list does.
 */
function documentId(entry: DocumentSummary): string {
  return entry.id ?? entry.path
}

/**
 * What `[[...]]` may name: BOTH the display name and the path, because both
 * are identifiers a reader could reasonably type and neither is a superset
 * of the other. A collision between one document's name and another's path
 * is left for the resolver's own ambiguity rule to reject — that reference
 * stays literal text rather than resolving to a guess.
 */
export function daemonLinkEntries(
  documents: readonly DocumentSummary[],
): readonly AliasResolverEntry[] {
  return documents.flatMap((entry) => {
    const id = documentId(entry)
    const byPath = { id, name: entry.path }
    return entry.displayName === undefined || entry.displayName === entry.path
      ? [byPath]
      : [{ id, name: entry.displayName }, byPath]
  })
}

/**
 * What the link picker offers: one row per document, under the name it is
 * known by. Unlike the resolver above this is a list a human reads, so a
 * document appearing twice would be noise rather than tolerance.
 */
export function daemonLinkTargets(documents: readonly DocumentSummary[]): readonly LinkTarget[] {
  return documents.map((entry) => ({
    id: documentId(entry),
    name: entry.displayName ?? entry.path,
    ...(entry.kind ? { kind: entry.kind } : {}),
  }))
}
