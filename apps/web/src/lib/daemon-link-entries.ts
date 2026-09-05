import type { UniqueNameEntry } from '@kamiazya/whiteboard-codec'
import type { DocumentSummary } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { LinkTarget } from './link-target.js'

/**
 * A daemon document has two names and they are not interchangeable. The
 * `path` is its address — auto-generated (`untitled-2`), ASCII-only, and
 * what a URL and a rename-following link key on. The `displayName` is the
 * only identifier the user ever chose, and the only one the UI shows.
 */

/**
 * What `[[...]]` may name: the PATH (and a document id, which the codec
 * resolves before consulting any table). Display names are retired from
 * resolution — path + id are the only written forms, and the display name
 * appears at render time as the link's label instead (owner decision,
 * 2026-09-03). A bracketed name is literal text, exactly as backlinks and
 * the daemon's own aggregate treat it.
 */
export function daemonLinkEntries(
  documents: readonly DocumentSummary[],
): readonly UniqueNameEntry[] {
  return documents.map((entry) => ({ id: entry.id, name: entry.path }))
}

/**
 * The render-time label for a linked document: what a bare `[[path]]` or
 * `[[id]]` shows instead of its address. One lookup, shared by both pages
 * so the two keepers cannot label the same link differently.
 */
export function daemonLinkTitles(
  documents: readonly DocumentSummary[],
): (documentId: string) => string | undefined {
  const byId = new Map(documents.map((entry) => [entry.id, entry.displayName ?? entry.path]))
  return (documentId) => byId.get(documentId)
}

/**
 * What the link picker offers: one row per document, under the name it is
 * known by. Unlike the resolver above this is a list a human reads, so a
 * document appearing twice would be noise rather than tolerance.
 */
/**
 * `excludeDocumentId` is the OPEN document: a link's whole job is to reach
 * some other document, and offering the one being edited invites the
 * self-reference the Connections surface would then have to explain away
 * (backlinks already skip self, so a self-link is invisible everywhere).
 */
export function daemonLinkTargets(
  documents: readonly DocumentSummary[],
  { excludeDocumentId }: { excludeDocumentId?: string } = {},
): readonly LinkTarget[] {
  return documents.flatMap((entry) => {
    if (entry.id === excludeDocumentId) return []
    return [
      {
        id: entry.id,
        path: entry.path,
        name: entry.displayName ?? entry.path,
        kind: entry.kind,
      },
    ]
  })
}
