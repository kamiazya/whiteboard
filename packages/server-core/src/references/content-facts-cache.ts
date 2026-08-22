import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument } from '../tools/document-io.js'
import { type ContentFacts, extractContentFacts } from './extract.js'

const EMPTY_FACTS: ContentFacts = { refs: [], texts: [], tags: undefined }

/**
 * Content-derived facts per document, kept between requests and validated
 * by the document's FRONTIER — the Loro version vector every persisting
 * writer updates (tools, WS sync, restore, import alike), because it is
 * what the sync protocol itself runs on.
 *
 * That is the load-bearing design choice: correctness does not depend on
 * enumerating write paths and hooking each one (the risk ADR-0014 deferred
 * the incremental mode over). A writer this cache has never heard of still
 * moves the frontier, and the stale entry is caught on the next read. An
 * event feed, if one ever lands, becomes an eager invalidation into this
 * same structure rather than a second source of truth.
 *
 * Only content facts live here. Index-authority meta (path/name/kind) is
 * read fresh from the listing per request — a rename needs no invalidation.
 */
export class ContentFactsCache {
  private readonly held = new Map<string, { stamp: string; facts: ContentFacts }>()

  /**
   * Facts for exactly `entries`, loading only documents whose frontier
   * moved (or were never seen) and evicting ids the listing no longer
   * contains. A document with no snapshot yet (frontier null) is empty
   * facts without a load.
   */
  async factsFor(
    deps: ServerDeps,
    entries: readonly DocumentEntry[],
  ): Promise<ReadonlyMap<string, ContentFacts>> {
    const wanted = new Set(entries.map((entry) => entry.documentId))
    for (const id of this.held.keys()) if (!wanted.has(id)) this.held.delete(id)

    const result = new Map<string, ContentFacts>()
    for (const entry of entries) {
      const frontier = await deps.documentStore.readFrontier({
        docRef: { kind: 'document', documentId: entry.documentId },
      })
      if (frontier === null) {
        this.held.delete(entry.documentId)
        result.set(entry.documentId, EMPTY_FACTS)
        continue
      }
      const stamp = stampOf(frontier.frontier)
      const cached = this.held.get(entry.documentId)
      if (cached !== undefined && cached.stamp === stamp) {
        result.set(entry.documentId, cached.facts)
        continue
      }
      const { doc } = await loadDocument(deps, entry.documentId)
      const facts = extractContentFacts(entry, doc)
      this.held.set(entry.documentId, { stamp, facts })
      result.set(entry.documentId, facts)
    }
    return result
  }
}

function stampOf(frontier: Uint8Array): string {
  // Byte identity is the whole contract: ports makes no ordering claim
  // about frontiers, and none is needed — any persisted change produces
  // different bytes.
  let out = ''
  for (const byte of frontier) out += byte.toString(16).padStart(2, '0')
  return out
}
