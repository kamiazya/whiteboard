import { ContentFactsCache, type DocumentContentSource } from '@kamiazya/whiteboard-reference-graph'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument, SnapshotNotFoundError } from '../tools/document-io.js'

/** The daemon's side of `reference-graph`'s port: its document store. */
function contentSourceFromDeps(deps: ServerDeps): DocumentContentSource {
  return {
    // Only asked for a listing entry with no content digest. One read per
    // document: the daemon holds a live document per path, so its frontier
    // IS that document's version and there is nothing to batch.
    async readVersions(workspaceId, documentIds) {
      const versions = new Map<string, Uint8Array | null>()
      for (const documentId of documentIds) {
        const read = await deps.documentStore.readFrontier({
          docRef: { kind: 'document', workspaceId, documentId },
        })
        versions.set(documentId, read === null ? null : read.frontier)
      }
      return versions
    },
    async loadDocument(workspaceId, documentId) {
      try {
        return (await loadDocument(deps, workspaceId, documentId)).doc
      } catch (err) {
        if (err instanceof SnapshotNotFoundError) return null
        throw err
      }
    },
  }
}

/** A facts cache over this server's store — the default a tool takes alone. */
export function factsCacheFor(deps: ServerDeps): ContentFactsCache {
  return new ContentFactsCache(contentSourceFromDeps(deps))
}
