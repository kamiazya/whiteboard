import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { LoroDoc } from 'loro-crdt'
import { type ContentFacts, extractContentFacts } from './extract.js'

const EMPTY_FACTS: ContentFacts = { refs: [], texts: [], bearers: [] }

/**
 * What the cache needs of a KEEPER: the two reads it cannot do itself.
 *
 * The daemon answers from its document store, the browser from IndexedDB —
 * which is exactly why this is a port and not a `ServerDeps`. Each keeper
 * writes one of these and nothing else, so what counts as a reference, and
 * when a cached answer is stale, stay written once for both.
 */
export interface DocumentContentSource {
  /**
   * The document's persisted frontier, or null when nothing is stored for it
   * yet. Only its BYTES matter: the cache compares them for identity and
   * makes no ordering claim about them.
   */
  readFrontier(
    workspaceId: string,
    documentId: DocumentEntry['documentId'],
  ): Promise<Uint8Array | null>
  /** The stored document. Asked only after `readFrontier` answered non-null. */
  loadDocument(workspaceId: string, documentId: DocumentEntry['documentId']): Promise<LoroDoc>
}

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
 * Whatever else a keeper derives from content (a vector, say) keys itself on
 * `stampOf`, so there is still ONE answer to "has this document changed".
 */
export class ContentFactsCache {
  /** workspaceId -> documentId -> stamped facts. Scoped so alternating
   *  requests across workspaces cannot evict each other's entries. */
  private readonly held = new Map<string, Map<string, { stamp: string; facts: ContentFacts }>>()

  constructor(private readonly source: DocumentContentSource) {}

  /**
   * Facts for exactly `entries` of one workspace, loading only documents
   * whose stamp moved (or were never seen) and evicting ids that
   * workspace's listing no longer contains. A document with no snapshot
   * yet (frontier null) is empty facts without a load.
   */
  async factsFor(
    workspaceId: string,
    entries: readonly DocumentEntry[],
  ): Promise<ReadonlyMap<string, ContentFacts>> {
    let held = this.held.get(workspaceId)
    if (held === undefined) {
      held = new Map()
      this.held.set(workspaceId, held)
    }
    const wanted = new Set(entries.map((entry) => entry.documentId))
    for (const id of held.keys()) if (!wanted.has(id)) held.delete(id)

    const result = new Map<string, ContentFacts>()
    for (const entry of entries) {
      const frontier = await this.source.readFrontier(workspaceId, entry.documentId)
      if (frontier === null) {
        held.delete(entry.documentId)
        result.set(entry.documentId, EMPTY_FACTS)
        continue
      }
      // The kind is part of the stamp: extraction branches on it, so facts
      // are only valid FOR the kind they were extracted under. No
      // listing-only kind mutation exists today — this closes the latent
      // trap rather than a reachable bug.
      const stamp = `${entry.kind ?? '?'}:${hexOf(frontier)}`
      const cached = held.get(entry.documentId)
      if (cached !== undefined && cached.stamp === stamp) {
        result.set(entry.documentId, cached.facts)
        continue
      }
      const facts = extractContentFacts(
        entry,
        await this.source.loadDocument(workspaceId, entry.documentId),
      )
      held.set(entry.documentId, { stamp, facts })
      result.set(entry.documentId, facts)
    }
    return result
  }

  /**
   * The stamp the last `factsFor` validated this document under, or
   * undefined when it holds none (never read, evicted, or nothing stored).
   * What a companion cache keys on so an edit invalidates it in the same
   * breath as the facts.
   */
  stampOf(workspaceId: string, documentId: string): string | undefined {
    return this.held.get(workspaceId)?.get(documentId)?.stamp
  }
}

function hexOf(frontier: Uint8Array): string {
  // Byte identity is the whole contract: ports makes no ordering claim
  // about frontiers, and none is needed — any persisted change produces
  // different bytes.
  let out = ''
  for (const byte of frontier) out += byte.toString(16).padStart(2, '0')
  return out
}
