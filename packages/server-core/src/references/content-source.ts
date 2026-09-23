import { ContentFactsCache, type DocumentContentSource } from '@kamiazya/whiteboard-reference-graph'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument } from '../tools/document-io.js'

/** The daemon's side of `reference-graph`'s port: its document store. */
function contentSourceFromDeps(deps: ServerDeps): DocumentContentSource {
  return {
    async readFrontier(workspaceId, documentId) {
      const read = await deps.documentStore.readFrontier({
        docRef: { kind: 'document', workspaceId, documentId },
      })
      return read === null ? null : read.frontier
    },
    async loadDocument(workspaceId, documentId) {
      return (await loadDocument(deps, workspaceId, documentId)).doc
    },
  }
}

/** A facts cache over this server's store — the default a tool takes alone. */
export function factsCacheFor(deps: ServerDeps): ContentFactsCache {
  return new ContentFactsCache(contentSourceFromDeps(deps))
}
