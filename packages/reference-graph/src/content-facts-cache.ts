import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { LoroDoc } from 'loro-crdt'
import { type ContentFacts, extractContentFacts } from './extract.js'

const EMPTY_FACTS: ContentFacts = { refs: [], texts: [], bearers: [] }

/**
 * What the cache needs of a KEEPER that it cannot read off the listing.
 *
 * The daemon answers from its document store, the browser from IndexedDB —
 * which is exactly why this is a port and not a `ServerDeps`. Each keeper
 * writes one of these and nothing else, so what counts as a reference, and
 * when a cached answer is stale, stay written once for both.
 */
export interface DocumentContentSource {
  /** The stored document, or null when nothing is stored for it yet. */
  loadDocument(
    workspaceId: string,
    documentId: DocumentEntry['documentId'],
  ): Promise<LoroDoc | null>
  /**
   * An opaque version per document, for entries whose listing carries no
   * `contentDigest` — an index that does not hold the content cannot derive
   * one. Equal bytes mean unchanged, null means nothing stored. Batched so a
   * keeper answers a whole listing in one read.
   *
   * OPTIONAL: a keeper whose every listing carries a digest has nothing to
   * say here, and a digest-less entry from a keeper without this is simply
   * re-read every time — the listing's own contract ("a consumer that finds
   * it absent must not memoise").
   */
  readVersions?(
    workspaceId: string,
    documentIds: readonly DocumentEntry['documentId'][],
  ): Promise<ReadonlyMap<string, Uint8Array | null>>
}

/**
 * Content-derived facts per document, kept between requests and validated
 * by the listing's `contentDigest` — a hash of the document's MERGED content,
 * computed at read time by the same function on both keepers.
 *
 * That is the load-bearing design choice: correctness does not depend on
 * enumerating write paths and hooking each one (the risk ADR-0014 deferred
 * the incremental mode over), nor on any replica's word about when it last
 * wrote. A writer this cache has never heard of still changes the content,
 * and a merge that produces a state nobody wrote still changes the digest.
 * An event feed, if one ever lands, becomes an eager invalidation into this
 * same structure rather than a second source of truth.
 *
 * An entry without a digest falls back to the keeper's own version
 * (`readVersions`), and without that is re-read every time.
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
   * workspace's listing no longer contains. A document with nothing stored
   * yet (version null) is empty facts without a load.
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

    const versions = await this.versionsWithoutDigest(workspaceId, entries)
    const result = new Map<string, ContentFacts>()
    for (const entry of entries) {
      result.set(
        entry.documentId,
        await this.factsForOne(workspaceId, entry, versionOf(entry, versions), held),
      )
    }
    return result
  }

  /**
   * One document's facts: the held ones when its stamp still matches, else
   * read and extracted — and held again only when there is a stamp to hold
   * them under and something was actually stored.
   */
  private async factsForOne(
    workspaceId: string,
    entry: DocumentEntry,
    version: string | null | undefined,
    held: Map<string, { stamp: string; facts: ContentFacts }>,
  ): Promise<ContentFacts> {
    if (version === null) {
      held.delete(entry.documentId)
      return EMPTY_FACTS
    }
    // The kind is part of the stamp: extraction branches on it, so facts are
    // only valid FOR the kind they were extracted under. No listing-only kind
    // mutation exists today — this closes the latent trap rather than a
    // reachable bug.
    const stamp = version === undefined ? undefined : `${entry.kind ?? '?'}:${version}`
    const cached = held.get(entry.documentId)
    if (stamp !== undefined && cached?.stamp === stamp) return cached.facts

    const doc = await this.source.loadDocument(workspaceId, entry.documentId)
    const facts = doc === null ? EMPTY_FACTS : extractContentFacts(entry, doc)
    if (stamp === undefined || doc === null) held.delete(entry.documentId)
    else held.set(entry.documentId, { stamp, facts })
    return facts
  }

  /** The keeper's versions for the entries the listing gave no digest. */
  private async versionsWithoutDigest(
    workspaceId: string,
    entries: readonly DocumentEntry[],
  ): Promise<ReadonlyMap<string, Uint8Array | null>> {
    const undigested = entries.filter((entry) => entry.contentDigest === undefined)
    if (undigested.length === 0 || this.source.readVersions === undefined) return new Map()
    return this.source.readVersions(
      workspaceId,
      undigested.map((entry) => entry.documentId),
    )
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

/**
 * What a document's stamp is built from: its digest when the listing has one,
 * else the keeper's version. `null` is "nothing stored"; `undefined` is "no
 * version to hold it under", which means read it and do not keep it.
 */
function versionOf(
  entry: DocumentEntry,
  versions: ReadonlyMap<string, Uint8Array | null>,
): string | null | undefined {
  if (entry.contentDigest !== undefined) return `digest:${entry.contentDigest}`
  if (!versions.has(entry.documentId)) return undefined
  const version = versions.get(entry.documentId) ?? null
  return version === null ? null : `version:${hexOf(version)}`
}

function hexOf(version: Uint8Array): string {
  // Byte identity is the whole contract: the port makes no ordering claim
  // about versions, and none is needed — any persisted change produces
  // different bytes.
  let out = ''
  for (const byte of version) out += byte.toString(16).padStart(2, '0')
  return out
}
