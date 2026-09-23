import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { ContentFacts, ContentFactsCache } from '@kamiazya/whiteboard-reference-graph'
import { assertVectorWidth, type Embedder } from './embedder.js'

interface HeldVector {
  /** The facts stamp this vector was embedded under. */
  stamp: string
  vector: Float32Array
  /** Which embedder made it — see `Embedder.id`. */
  from: string
}

/**
 * Each document's vector, kept between searches and embedded again only when
 * the document changed.
 *
 * "Changed" is the facts cache's answer, read through `stampOf` — never a
 * second stamp of this cache's own. A vector is embedded from the same texts
 * the facts hold, so the two must go stale together, and one stamp is what
 * makes that structural rather than a matter of keeping two in step.
 *
 * Kept apart from the facts because embedding is this server's capability
 * and not the graph's: `reference-graph` is shared with a keeper that has no
 * embedder, and a vector field there would be one it never fills.
 */
export class DocumentVectorCache {
  private readonly held = new Map<string, Map<string, HeldVector>>()

  constructor(readonly facts: ContentFactsCache) {}

  /**
   * Vectors for `entries`, embedding only what the stamp says is new or
   * changed — the same validation the facts use, so an untouched document is
   * never re-embedded even though embedding is the expensive half.
   *
   * A vector from a different embedder is not a hit: it belongs to another
   * vector space, and reusing it would have the query measured against
   * documents nobody scored the same way.
   */
  async vectorsFor(
    workspaceId: string,
    entries: readonly DocumentEntry[],
    embedder: Embedder,
  ): Promise<{ documentId: string; vector: Float32Array }[]> {
    // Facts first: this validates the per-document stamps the rest reads.
    const facts = await this.facts.factsFor(workspaceId, entries)
    let held = this.held.get(workspaceId)
    if (held === undefined) {
      held = new Map()
      this.held.set(workspaceId, held)
    }
    const wanted = new Set(entries.map((entry) => entry.documentId))
    for (const id of held.keys()) if (!wanted.has(id)) held.delete(id)

    const pending = this.pendingEmbeds(workspaceId, entries, facts, held, embedder)
    if (pending.length > 0) {
      const vectors = await embedder.embed(
        pending.map((p) => p.text),
        'document',
      )
      assertVectorWidth(vectors, embedder)
      pending.forEach((p, index) => {
        const vector = vectors[index]
        if (vector !== undefined)
          held.set(p.documentId, { stamp: p.stamp, vector, from: embedder.id })
      })
    }

    const out: { documentId: string; vector: Float32Array }[] = []
    for (const entry of entries) {
      const cached = this.current(workspaceId, held, entry.documentId, embedder)
      if (cached !== undefined) out.push({ documentId: entry.documentId, vector: cached.vector })
    }
    return out
  }

  /** A held vector, if it is still THE vector: same stamp, same embedder. */
  private current(
    workspaceId: string,
    held: ReadonlyMap<string, HeldVector>,
    documentId: string,
    embedder: Embedder,
  ): HeldVector | undefined {
    const stamp = this.facts.stampOf(workspaceId, documentId)
    const cached = held.get(documentId)
    return stamp !== undefined && cached?.stamp === stamp && cached.from === embedder.id
      ? cached
      : undefined
  }

  /**
   * Which of `entries` still need a vector from THIS embedder, with the text
   * to embed.
   *
   * The name and path are embedded alongside the body, so a document that is
   * only a title still gets a vector — otherwise it would sit in the lexical
   * ranking with no semantic counterpart and be judged by half the evidence.
   * Only a document with nothing at all is skipped.
   */
  private pendingEmbeds(
    workspaceId: string,
    entries: readonly DocumentEntry[],
    facts: ReadonlyMap<string, ContentFacts>,
    held: ReadonlyMap<string, HeldVector>,
    embedder: Embedder,
  ): { documentId: string; stamp: string; text: string }[] {
    const pending: { documentId: string; stamp: string; text: string }[] = []
    for (const entry of entries) {
      const stamp = this.facts.stampOf(workspaceId, entry.documentId)
      if (stamp === undefined) continue
      if (this.current(workspaceId, held, entry.documentId, embedder) !== undefined) continue
      const text = [entry.name ?? '', entry.path, ...(facts.get(entry.documentId)?.texts ?? [])]
        .join('\n')
        .trim()
      if (text !== '') pending.push({ documentId: entry.documentId, stamp, text })
    }
    return pending
  }
}
