import { emojiSearchText } from '@kamiazya/whiteboard-plugin-visual/emoji/searchable'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { ContentFacts, ContentFactsCache } from '@kamiazya/whiteboard-reference-graph'
import {
  type AlsoIndex,
  type DocumentTerms,
  documentTerms,
  type SearchableDocument,
} from '@kamiazya/whiteboard-search'

interface HeldTerms {
  /** The facts object these terms were built from — see `termsOf`. */
  facts: ContentFacts
  path: string
  name: string | undefined
  terms: DocumentTerms
}

/**
 * Each document's search terms, kept between queries and built again only
 * when the document changed — so a query costs scoring, not re-tokenizing
 * the whole workspace.
 *
 * "Changed" is the facts cache's answer, read as the IDENTITY of the facts
 * object it handed out: the cache returns the same object for as long as a
 * document's stamp holds, and a new one the moment it moves or when it keeps
 * no stamp at all. Reading `stampOf` instead would race: a concurrent
 * `factsFor` can advance a stamp between this request's read of the texts
 * and its read of the stamp, filing old terms under the new stamp for good.
 * The path and name are not content and carry no stamp, so they are compared
 * directly: a rename re-indexes that document and nothing else.
 *
 * Bounded like its siblings: per workspace, by the listing — an id the
 * latest listing does not hold is dropped — and per document by
 * `DOCUMENT_TERMS_MAX`.
 */
export class DocumentTermsCache {
  private readonly held = new Map<string, Map<string, HeldTerms>>()

  constructor(
    private readonly facts: ContentFactsCache,
    private readonly alsoIndex: AlsoIndex,
  ) {}

  /**
   * The `termsOf` for one query over `entries` of a workspace, whose facts
   * `content` is — `fullTextSearch` calls it once per candidate document.
   */
  termsOf(
    workspaceId: string,
    entries: readonly DocumentEntry[],
    content: ReadonlyMap<string, ContentFacts>,
  ): (doc: SearchableDocument) => DocumentTerms {
    let held = this.held.get(workspaceId)
    if (held === undefined) {
      held = new Map()
      this.held.set(workspaceId, held)
    }
    const wanted = new Set(entries.map((entry) => entry.documentId))
    for (const id of held.keys()) if (!wanted.has(id)) held.delete(id)

    const kept = held
    return (doc) => {
      const facts = content.get(doc.documentId)
      const cached = kept.get(doc.documentId)
      if (
        facts !== undefined &&
        cached?.facts === facts &&
        cached.path === doc.path &&
        cached.name === doc.name
      ) {
        return cached.terms
      }
      const terms = documentTerms(doc, this.alsoIndex)
      // Held only under a stamp: facts the cache would not keep are rebuilt
      // on every read, so terms keyed on them could never be hit again.
      if (facts !== undefined && this.facts.stampOf(workspaceId, doc.documentId) !== undefined) {
        kept.set(doc.documentId, { facts, path: doc.path, name: doc.name, terms })
      } else {
        kept.delete(doc.documentId)
      }
      return terms
    }
  }
}

const termsCaches = new WeakMap<ContentFactsCache, DocumentTermsCache>()

/**
 * The terms cache over this facts cache, held beside it so a per-request
 * server keeps the index it built, indexing what a document shows as emoji
 * by name the way every search on this server does. Keyed on the FACTS cache
 * rather than the deps because identity of its facts objects is what
 * validates every entry: terms read against any other facts cache would
 * never be hit.
 */
export function termsCacheFor(facts: ContentFactsCache): DocumentTermsCache {
  let cache = termsCaches.get(facts)
  if (cache === undefined) {
    cache = new DocumentTermsCache(facts, emojiSearchText)
    termsCaches.set(facts, cache)
  }
  return cache
}
