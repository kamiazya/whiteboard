import { emojiSearchText } from '@kamiazya/whiteboard-plugin-visual/emoji/searchable'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { ContentFacts } from '@kamiazya/whiteboard-reference-graph'
import { fullTextSearch, type SearchableDocument } from '@kamiazya/whiteboard-search'
import { factsCacheFor } from '../references/content-source.js'
import { DocumentVectorCache } from '../search/document-vector-cache.js'
import type { Embedder } from '../search/embedder.js'
import { assertVectorWidth, rankByVector } from '../search/embedder.js'
import { fuseByRank } from '../search/rrf.js'
import type { ServerDeps } from '../server-deps.js'

/** Neither words nor a filter names nothing to find; the list is wb_document_list's. */
export class SearchNeedsQueryOrFilterError extends Error {
  constructor() {
    super(
      'Nothing to search for: pass `query` (words to match), or `tags` / `kind` (a filter to answer alone), or both. To list every document, use wb_document_list.',
    )
    this.name = 'SearchNeedsQueryOrFilterError'
  }
}

import {
  type DocumentSearchInput,
  type DocumentSearchOutput,
  documentSearchInputSchema,
  documentSearchOutputSchema,
} from './document-search.schemas.js'

export {
  type DocumentSearchInput,
  type DocumentSearchOutput,
  documentSearchInputSchema,
  documentSearchOutputSchema,
} from './document-search.schemas.js'

/**
 * Lexical search across a workspace: markdown bodies, canvas text (nodes,
 * group labels, edge labels — a canvas means through its RELATIONS, so edge
 * labels are content, not decoration), names and paths.
 *
 * Corpus served from the stamp-validated ContentFactsCache shared with
 * backlinks/mentions and tags — only documents whose frontier moved are
 * reloaded (ADR-0014's incremental mode, cache form).
 *
 * With `deps.embedder` supplied it also searches by MEANING, fusing the two
 * rankings; without one it is lexical search and nothing else.
 */
type SearchCandidate = SearchableDocument & {
  kind?: 'markdown' | 'spatial'
  /** The nodes and edges a tag filter matched, named for the excerpt. */
  named: readonly string[]
}

/**
 * Which documents are candidates, and what a tag filter matched on each.
 *
 * The filters are applied here rather than by the ranker because they decide
 * MEMBERSHIP, not order: a document a tag filter excludes is not a low-ranked
 * result, it is not a result. ONE bearer has to carry every listed tag
 * (ADR-0040 decision 3) — a note by its frontmatter, a board by its own tags,
 * or one node or edge — which is why this cannot be a flat tag-set test.
 */
function collectSearchable(
  entries: readonly DocumentEntry[],
  content: ReadonlyMap<string, ContentFacts>,
  parsed: DocumentSearchInput,
): SearchCandidate[] {
  const searchable: SearchCandidate[] = []
  for (const entry of entries) {
    const facts = content.get(entry.documentId)
    // Narrowing for `Map.get`, not a branch: `factsFor` sets an entry
    // for EVERY entry it is given — `EMPTY_FACTS` when the document
    // cannot be read — so this cannot fire for a listing it was handed.
    // Deleting it leaves every test green, which reads like an untested
    // branch and is not one.
    if (facts === undefined) continue
    if (parsed.kind !== undefined && entry.kind !== parsed.kind) continue
    // ONE bearer carries every listed tag (ADR-0040 decision 3): a note
    // by its frontmatter, a board by its own tags, or one node or edge.
    let named: string[] = []
    if (parsed.tags !== undefined) {
      const wanted = parsed.tags
      const carrying = facts.bearers.filter((bearer) =>
        wanted.every((tag) => bearer.tags.includes(tag)),
      )
      if (carrying.length === 0) continue
      named = carrying.filter((bearer) => bearer.text.length > 0).map((bearer) => bearer.text)
    }
    searchable.push({
      documentId: entry.documentId,
      path: entry.path,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      texts: [...facts.texts],
      named,
    })
  }
  return searchable
}

export function createDocumentSearchTool(
  deps: ServerDeps,
  vectors: DocumentVectorCache = new DocumentVectorCache(factsCacheFor(deps)),
) {
  return {
    name: 'wb_document_search' as const,
    description:
      'Find documents by content, or by tag. `query` is full-text over markdown bodies and canvas text (nodes, group labels, edge labels), plus names and paths; Japanese works without a dictionary. `tags` and `kind` filter, and stand alone without a query — "every document tagged X" is a filter, since a tag is frontmatter rather than content. Returns ranked matches with context excerpts; scores compare within one response only.',
    inputSchema: documentSearchInputSchema,
    outputSchema: documentSearchOutputSchema,
    async execute(input: DocumentSearchInput): Promise<DocumentSearchOutput> {
      const parsed = documentSearchInputSchema.parse(input)
      if (parsed.query === undefined && parsed.tags === undefined && parsed.kind === undefined) {
        throw new SearchNeedsQueryOrFilterError()
      }
      const entries = await deps.documentIndex.listDocuments({ workspaceId: parsed.workspaceId })
      const content = await vectors.facts.factsFor(parsed.workspaceId, entries)

      const searchable = collectSearchable(entries, content, parsed)

      const byId = new Map(searchable.map((doc) => [doc.documentId, doc]))
      /** documentId -> 1-based position, for whichever rankings exist. */
      const ranksOf = (ranking: readonly string[]): Map<string, number> =>
        new Map(ranking.map((documentId, index) => [documentId, index + 1]))
      const describe = (
        documentId: string,
        score: number,
        contexts: readonly string[],
        ranks: { lexical?: number; semantic?: number },
      ) => {
        const doc = byId.get(documentId)
        return {
          documentId,
          path: doc?.path ?? documentId,
          ...(doc?.name === undefined ? {} : { name: doc.name }),
          ...(doc?.kind === undefined ? {} : { kind: doc.kind }),
          score,
          contexts: [...contexts],
          ...(ranks.lexical === undefined ? {} : { lexicalRank: ranks.lexical }),
          ...(ranks.semantic === undefined ? {} : { semanticRank: ranks.semantic }),
        }
      }

      // A filter with no words: every admitted document, in path order,
      // with nothing ranked and the opening of its text for context — the
      // shape a semantic-only hit already has, so a reader needs no third.
      if (parsed.query === undefined) {
        const admitted = [...searchable].sort((a, b) => a.path.localeCompare(b.path))
        return {
          results: admitted
            .slice(0, parsed.limit)
            .map((doc) =>
              describe(doc.documentId, 0, doc.named.length > 0 ? doc.named : openingOf(doc), {}),
            ),
        }
      }
      const query = parsed.query

      // The optional semantic half. Absent, this returns exactly what it
      // returned before embeddings existed; supplied, its ranking is FUSED
      // with BM25's by rank rather than mixed by score, and any failure
      // inside it degrades to lexical-only rather than failing the search.
      const { embedder } = deps
      if (embedder === undefined) {
        // The returned page IS the prefix of the full ranking here, so the
        // index is the rank.
        const hits = fullTextSearch(searchable, query, {
          limit: parsed.limit,
          alsoIndex: emojiSearchText,
        })
        return {
          results: hits.map((hit, index) =>
            describe(hit.documentId, hit.score, hit.contexts, { lexical: index + 1 }),
          ),
        }
      }

      // Fusion needs the WHOLE lexical ranking, not the page the caller asked
      // for: a document the vector half also likes can climb from rank 20.
      const lexical = fullTextSearch(searchable, query, {
        limit: searchable.length,
        alsoIndex: emojiSearchText,
      })
      const semantic = await rankSemantically(
        vectors,
        parsed.workspaceId,
        entries.filter((entry) => byId.has(entry.documentId)),
        query,
        embedder,
      )
      if (semantic === undefined) {
        return {
          results: lexical
            .slice(0, parsed.limit)
            .map((hit, index) =>
              describe(hit.documentId, hit.score, hit.contexts, { lexical: index + 1 }),
            ),
        }
      }

      const fused = fuseByRank([lexical.map((hit) => hit.documentId), semantic])
      const contexts = new Map(lexical.map((hit) => [hit.documentId, hit.contexts]))
      // Ranks come from the COMPLETE rankings, not from the page returned:
      // "3rd of 45" and "3rd of 5" are different facts, and only the former
      // survives a change of `limit`.
      const lexicalRanks = ranksOf(lexical.map((hit) => hit.documentId))
      const semanticRanks = ranksOf(semantic)
      /**
       * Fused ties are the NORM, not an edge case: reciprocal-rank sums
       * collide by construction, so a document at lexical 1 / semantic 2
       * scores exactly what one at lexical 2 / semantic 1 does. Of the 400
       * rank pairs inside the top 20, only 210 distinct scores exist and
       * 190 are shared.
       *
       * Broken on evidence rather than on identity. The document whose
       * keywords matched better wins, because those are the words the user
       * actually typed; between two documents keywords never matched, the
       * closer meaning wins. Ranks within a list are unique, so this is a
       * total order with no appeal to a document id — which mattered, since
       * an id is `encodeTime(Date.now()) + encodeRandom()` and ordering by
       * it answered "which was written first", with chance deciding inside
       * a millisecond.
       */
      const FAR = Number.MAX_SAFE_INTEGER
      const ordered = [...fused.entries()]
        .sort(
          (a, b) =>
            b[1] - a[1] ||
            (lexicalRanks.get(a[0]) ?? FAR) - (lexicalRanks.get(b[0]) ?? FAR) ||
            (semanticRanks.get(a[0]) ?? FAR) - (semanticRanks.get(b[0]) ?? FAR),
        )
        .map(([documentId]) => documentId)
      return {
        results: ordered
          .slice(0, parsed.limit)
          .map((documentId) =>
            describe(
              documentId,
              fused.get(documentId) ?? 0,
              contexts.get(documentId) ?? openingOf(byId.get(documentId)),
              { lexical: lexicalRanks.get(documentId), semantic: semanticRanks.get(documentId) },
            ),
          ),
      }
    },
  }
}

/**
 * The vector ranking, or `undefined` when the embedder cannot answer.
 *
 * Failure here is NOT a search failure: semantic recall is an addition, and
 * a model that is still loading, out of memory, or simply absent should cost
 * the user nothing worse than the lexical results they had before.
 */
async function rankSemantically(
  vectors: DocumentVectorCache,
  workspaceId: string,
  entries: readonly DocumentEntry[],
  query: string,
  embedder: Embedder,
): Promise<string[] | undefined> {
  try {
    const documents = await vectors.vectorsFor(workspaceId, entries, embedder)
    if (documents.length === 0) return []
    const [queryVector] = await embedder.embed([query], 'query')
    if (queryVector === undefined) return undefined
    assertVectorWidth([queryVector], embedder)
    return rankByVector(queryVector, documents)
  } catch {
    return undefined
  }
}

/** First line of a document's text, for a hit with no keyword to excerpt. */
function openingOf(doc: { texts: readonly string[] } | undefined): string[] {
  const text = doc?.texts.find((candidate) => candidate.trim() !== '')
  return text === undefined ? [] : [text.slice(0, 120)]
}
