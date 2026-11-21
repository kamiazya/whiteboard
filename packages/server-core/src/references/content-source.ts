import { ContentFactsCache, type DocumentContentSource } from '@kamiazya/whiteboard-reference-graph'
import { SnapshotNotFoundError } from '../document-io.js'
import { withDocument } from '../document-session.js'
import { contentOf } from '../document-session-reads.js'
import type { ServerDeps } from '../server-deps.js'

/** The daemon's side of `reference-graph`'s port: its document store. */
function contentSourceFromDeps(deps: ServerDeps): DocumentContentSource {
  return {
    // No `readVersions`: the daemon's listing carries a content digest for every
    // document, and that digest is the stamp the cache validates on.
    async loadContent(workspaceId, entry) {
      try {
        return await withDocument(deps, workspaceId, entry.documentId, (session) =>
          contentOf(session, entry.kind),
        )
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
