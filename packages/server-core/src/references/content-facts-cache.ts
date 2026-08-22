import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument } from '../tools/document-io.js'
import type { Embedder } from '../search/embedder.js'
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
  /** workspaceId -> documentId -> stamped facts. Scoped so alternating
   *  requests across workspaces cannot evict each other's entries. */
  /** workspaceId -> documentId -> stamped facts, plus its vector once one
   *  has been asked for. The vector rides the SAME stamp as the facts, so
   *  an edit invalidates both together and neither can go stale alone. */
  private readonly held = new Map<
    string,
    Map<string, { stamp: string; facts: ContentFacts; vector?: Float32Array }>
  >()

  /**
   * Facts for exactly `entries` of one workspace, loading only documents
   * whose stamp moved (or were never seen) and evicting ids that
   * workspace's listing no longer contains. A document with no snapshot
   * yet (frontier null) is empty facts without a load.
   */
  async factsFor(
    deps: ServerDeps,
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
      const frontier = await deps.documentStore.readFrontier({
        docRef: { kind: 'document', documentId: entry.documentId },
      })
      if (frontier === null) {
        held.delete(entry.documentId)
        result.set(entry.documentId, EMPTY_FACTS)
        continue
      }
      // The kind is part of the stamp: extraction branches on it, so facts
      // are only valid FOR the kind they were extracted under. No
      // listing-only kind mutation exists today — this closes the latent
      // trap rather than a reachable bug.
      const stamp = `${entry.kind ?? '?'}:${stampOf(frontier.frontier)}`
      const cached = held.get(entry.documentId)
      if (cached !== undefined && cached.stamp === stamp) {
        result.set(entry.documentId, cached.facts)
        continue
      }
      const { doc } = await loadDocument(deps, entry.documentId)
      const facts = extractContentFacts(entry, doc)
      held.set(entry.documentId, { stamp, facts })
      result.set(entry.documentId, facts)
    }
    return result
  }

  /**
   * Vectors for `entries`, embedding only what the stamp says is new or
   * changed — the same validation the facts use, so an untouched document
   * is never re-embedded even though embedding is the expensive half.
   *
   * The name and path are embedded alongside the body, so a document that
   * is only a title still gets a vector — otherwise it would sit in the
   * lexical ranking with no semantic counterpart and be judged by half the
   * evidence. Only a document with nothing at all is skipped.
   */
  async vectorsFor(
    deps: ServerDeps,
    workspaceId: string,
    entries: readonly DocumentEntry[],
    embedder: Embedder,
  ): Promise<{ documentId: string; vector: Float32Array }[]> {
    // Facts first: this fills/validates the per-document stamps, so the
    // loop below only has to ask which ones still lack a vector.
    const facts = await this.factsFor(deps, workspaceId, entries)
    const held = this.held.get(workspaceId)
    if (held === undefined) return []

    const pending: { documentId: string; text: string }[] = []
    for (const entry of entries) {
      const cached = held.get(entry.documentId)
      if (cached === undefined || cached.vector !== undefined) continue
      const text = [entry.name ?? '', entry.path, ...(facts.get(entry.documentId)?.texts ?? [])]
        .join('\n')
        .trim()
      if (text === '') continue
      pending.push({ documentId: entry.documentId, text })
    }
    if (pending.length > 0) {
      const vectors = await embedder.embed(pending.map((p) => p.text))
      pending.forEach((p, index) => {
        const cached = held.get(p.documentId)
        const vector = vectors[index]
        if (cached !== undefined && vector !== undefined) cached.vector = vector
      })
    }

    const out: { documentId: string; vector: Float32Array }[] = []
    for (const entry of entries) {
      const vector = held.get(entry.documentId)?.vector
      if (vector !== undefined) out.push({ documentId: entry.documentId, vector })
    }
    return out
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
