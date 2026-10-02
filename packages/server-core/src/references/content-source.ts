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

const factsCaches = new WeakMap<ServerDeps, ContentFactsCache>()

/**
 * The facts cache over this server's store, one per `ServerDeps` rather than
 * per `createServer` call: a root that builds a server for every request (the
 * daemon's `/mcp`) would otherwise start each search from an empty cache,
 * paying the full reload the cache exists to skip. Held by the deps' identity
 * so a long-lived REST server and a per-request MCP server over the same
 * deps validate one set of stamps, and a deps object that goes away takes its
 * cache with it. Staleness is not this map's concern — every entry is
 * stamp-validated against the store on each read.
 */
export function factsCacheFor(deps: ServerDeps): ContentFactsCache {
  let cache = factsCaches.get(deps)
  if (cache === undefined) {
    cache = new ContentFactsCache(contentSourceFromDeps(deps))
    factsCaches.set(deps, cache)
  }
  return cache
}
