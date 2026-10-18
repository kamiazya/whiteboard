import { compareCodeUnit } from '@kamiazya/whiteboard-model'
import { snippetAround } from './snippet.js'

/**
 * Dictionary-free lexical search: latin runs tokenize as lowercased words,
 * CJK runs as adjacent character bigrams — the standard CJK trade (recall
 * over precision) that works for Japanese, Chinese and Korean alike with
 * zero download, which is why stage 0 of the search plan starts here. A
 * lone CJK character (a run of length one) is its own token rather than
 * disappearing.
 *
 * This is the QUERY tokenizer, and it is deliberately narrower than
 * `tokenizeForIndex`: a two-character query means the pair, so it must not
 * also match every document that happens to share one of the two.
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/
const WORD = /[\p{L}\p{N}]+/gu

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  tokenizeRuns(text, false, (token) => {
    tokens.push(token)
    return true
  })
  return tokens
}

/**
 * The INDEX side, which additionally emits every CJK character on its own.
 *
 * Symmetric bigram tokenization cannot answer a one-character query at all:
 * a name is a single CJK run, so it yields bigrams only, and 「た」 — the
 * first keystroke of nearly every Japanese query — matches none of them.
 * The asymmetry is the standard fix (Lucene spells it `outputUnigrams`):
 * widen what a document is FOUND BY, not what a query demands.
 */
export function tokenizeForIndex(text: string): string[] {
  const tokens: string[] = []
  tokenizeRuns(text, true, (token) => {
    tokens.push(token)
    return true
  })
  return tokens
}

/**
 * Feeds each token to `emit` in text order, stopping as soon as `emit`
 * answers false; answers false itself when it was stopped.
 */
function tokenizeRuns(text: string, unigrams: boolean, emit: (token: string) => boolean): boolean {
  for (const match of text.toLowerCase().matchAll(WORD)) {
    for (const stretch of scriptStretches(match[0])) {
      if (!emitStretch(stretch, unigrams, emit)) return false
    }
  }
  return true
}

interface Stretch {
  readonly text: string
  readonly cjk: boolean
}

/**
 * A run split into its CJK and non-CJK stretches: "bm25で検索" arrives as one
 * \p{L}\p{N} run, and word-tokenizing it whole would glue the scripts
 * together into a token nobody types.
 */
function scriptStretches(run: string): Stretch[] {
  const stretches: Stretch[] = []
  let current = ''
  let cjk = false
  for (const char of run) {
    const isCjk = CJK.test(char)
    if (current !== '' && isCjk !== cjk) {
      stretches.push({ text: current, cjk })
      current = ''
    }
    cjk = isCjk
    current += char
  }
  if (current !== '') stretches.push({ text: current, cjk })
  return stretches
}

function emitStretch(
  { text, cjk }: Stretch,
  unigrams: boolean,
  emit: (token: string) => boolean,
): boolean {
  if (!cjk) return emit(text)
  if (unigrams || text.length === 1) {
    for (const char of text) if (!emit(char)) return false
  }
  for (let i = 0; i + 1 < text.length; i++) if (!emit(text.slice(i, i + 2))) return false
  return true
}

export interface SearchableDocument {
  readonly documentId: string
  readonly path: string
  readonly name?: string
  /** Body / node / label texts, each a separate string so snippets stay per-source. */
  readonly texts: readonly string[]
}

export interface SearchHit {
  readonly documentId: string
  readonly score: number
  /** Excerpts around the first match per text that contains one. */
  readonly contexts: readonly string[]
}

// Standard BM25 constants; nothing here has been tuned against a corpus,
// and tuning without a scoreboard would be the measured-change anti-pattern.
const K1 = 1.2
const B = 0.75

/**
 * Extra searchable text a caller derives from a document's own content.
 *
 * The seam exists so that this package keeps depending on `model` alone. An
 * emoji is the first customer — a document that SHOWS a rocket says
 * `rocket` nowhere, and the vocabulary that knows it does is a PLUGIN's,
 * which sits above this package in the dependency direction. Both callers
 * of `fullTextSearch` already depend on that plugin, so they pass the
 * expander rather than this package reaching up for it.
 *
 * It answers TEXT and not tokens, deliberately: how 「ロケット」 is cut up
 * is this package's scheme to own, and a caller returning tokens would be a
 * second place that decides it.
 *
 * Indexing only. A snippet quotes what the document actually says, so
 * derived text must never reach `excerpterFor` — a hit on a word the reader
 * cannot see in their own note is confusing enough without the excerpt
 * inventing it.
 */
export type AlsoIndex = (text: string) => string

function addTo(text: string, alsoIndex: AlsoIndex): string {
  const extra = alsoIndex(text)
  return extra === '' ? text : `${text} ${extra}`
}

/**
 * The most distinct terms one document contributes to the index.
 *
 * Without a ceiling a document's size in the index is its vocabulary, and a
 * MARKDOWN_MAX_CHARS body of unrelated CJK ideographs has about 283,000
 * distinct terms — 21.5 MB of token bag, against 2,849 for the largest
 * document in this repository (a 110K-character changelog). A workspace
 * multiplies that by its document ceiling.
 *
 * At the ceiling indexing STOPS, rather than skipping new terms and counting
 * on: a document is found by what it says up to that point, and the path and
 * name come first so they are always indexed. Stopping also bounds the time
 * spent on such a document, since the rest of it is never tokenized. A
 * document under the ceiling is indexed whole and ranks exactly as it did.
 */
export const DOCUMENT_TERMS_MAX = 8192

/**
 * What one document contributes to the index: how often each index token
 * occurs across its path, name and texts, and how many tokens that is.
 *
 * A pure function of the document's text and the expander, so a caller that
 * knows when a document changed can build it once per version and hand it
 * back through `fullTextSearch`'s `termsOf` — this package has no notion of
 * a version to key it on.
 */
export interface DocumentTerms {
  readonly counts: ReadonlyMap<string, number>
  readonly length: number
}

export function documentTerms(
  doc: Pick<SearchableDocument, 'path' | 'name' | 'texts'>,
  alsoIndex?: AlsoIndex,
): DocumentTerms {
  const counts = new Map<string, number>()
  let length = 0
  const count = (token: string): boolean => {
    const held = counts.get(token)
    if (held === undefined && counts.size >= DOCUMENT_TERMS_MAX) return false
    counts.set(token, (held ?? 0) + 1)
    length++
    return true
  }
  for (const text of [doc.path, doc.name ?? '', ...doc.texts]) {
    const indexed = alsoIndex === undefined ? text : addTo(text, alsoIndex)
    if (!tokenizeRuns(indexed, true, count)) break
  }
  return { counts, length }
}

interface TokenBag extends DocumentTerms {
  readonly doc: SearchableDocument
}

interface SearchOptions {
  readonly limit?: number
  /**
   * False answers every hit with no contexts, for a caller whose returned
   * page is not a prefix of this ranking (fusion) and so excerpts only that
   * page itself, through `excerpterFor`.
   */
  readonly excerpts?: boolean
  readonly alsoIndex?: AlsoIndex
  /**
   * Where each document's terms come from, for a caller that holds them
   * between queries. Supplied, it owns indexing outright: `alsoIndex` is
   * then the caller's to have applied when it built them.
   */
  readonly termsOf?: (doc: SearchableDocument) => DocumentTerms
}

/**
 * BM25 over the documents' token bags, name and path included as text (a
 * query naming a document should find it without the caller special-casing
 * fields). Scores are relative to THIS corpus — never compare across calls.
 */
export function fullTextSearch(
  documents: readonly SearchableDocument[],
  query: string,
  {
    limit = 10,
    excerpts = true,
    alsoIndex,
    termsOf = (doc) => documentTerms(doc, alsoIndex),
  }: SearchOptions = {},
): SearchHit[] {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0) return []

  const bags: TokenBag[] = documents.map((doc) => ({ doc, ...termsOf(doc) }))
  const avgLength = bags.reduce((sum, bag) => sum + bag.length, 0) / Math.max(1, bags.length)
  // Once per query token, not per (document, token) pair: counting the
  // documents that hold a token inside the scoring loop made one query
  // documents² × tokens, seconds on a few hundred notes.
  const idf = queryTokens.map((token) => {
    const containing = bags.filter((bag) => bag.counts.has(token)).length
    return Math.log(1 + (bags.length - containing + 0.5) / (containing + 0.5))
  })

  const scored: { doc: SearchableDocument; score: number }[] = []
  for (const bag of bags) {
    let score = 0
    for (const [i, token] of queryTokens.entries()) {
      const tf = bag.counts.get(token) ?? 0
      if (tf === 0) continue
      score +=
        ((idf[i] ?? 0) * tf * (K1 + 1)) /
        (tf + K1 * (1 - B + (B * bag.length) / Math.max(1, avgLength)))
    }
    if (score > 0) scored.push({ doc: bag.doc, score })
  }
  // Excerpts only for what is answered: they cost a scan of every text per
  // query token, and ranking never reads them.
  scored.sort((a, b) => b.score - a.score || compareCodeUnit(a.doc.documentId, b.doc.documentId))
  const contextsFor = excerpts ? excerpterFor(query) : () => []
  return scored.slice(0, limit).map(({ doc, score }) => ({
    documentId: doc.documentId,
    score,
    contexts: contextsFor(doc),
  }))
}

/**
 * The most distinct query tokens an excerpt looks for, in query order.
 *
 * Each one is a scan of every answered text, so an unbounded query is a
 * multiplier on up to MARKDOWN_MAX_CHARS per text: the longest accepted query
 * holds 1,023 distinct CJK bigrams. 64 is over three times the tokens of the
 * longest query in either judged search corpus (a 20-character Japanese
 * phrase, 19 bigrams), so an ordinary query is excerpted exactly as before;
 * ranking always reads every token, so only which excerpt is quoted can
 * differ, and only for a query past this.
 */
export const EXCERPT_TOKENS_MAX = 64

interface Match {
  readonly index: number
  readonly length: number
  /** The query's distinct tokens this text holds; a verbatim hit outranks any count of them. */
  readonly score: number
}

/**
 * Where the query matches `lower`: the raw needle if it occurs verbatim,
 * otherwise the earliest matching token.
 */
function firstMatch(lower: string, needle: string, tokens: readonly string[]): Match | undefined {
  const verbatim = needle === '' ? -1 : lower.indexOf(needle)
  if (verbatim !== -1) {
    return { index: verbatim, length: needle.length, score: tokens.length + 1 }
  }
  let best: { index: number; length: number } | undefined
  let matched = 0
  for (const token of tokens) {
    const at = lower.indexOf(token)
    if (at === -1) continue
    matched++
    if (best === undefined || at < best.index) best = { index: at, length: token.length }
  }
  return best === undefined ? undefined : { ...best, score: matched }
}

/**
 * Excerpts, the three texts that match the query best: one holding it
 * VERBATIM first (the most readable snippet), then by how many of its tokens
 * a text holds, ties in document order. Document order alone quoted the
 * first three texts that mentioned any one word, so the text that held the
 * whole query could sit fourth and never be shown.
 *
 * A query that only matches token-wise centres on the first matching token.
 * Built once per query, so its tokens are cut up once rather than per hit.
 */
export function excerpterFor(query: string): (doc: Pick<SearchableDocument, 'texts'>) => string[] {
  const needle = query.trim().toLowerCase()
  const tokens = [...new Set(tokenize(query))].slice(0, EXCERPT_TOKENS_MAX)
  return (doc) =>
    doc.texts
      .flatMap((text, order) => {
        const match = firstMatch(text.toLowerCase(), needle, tokens)
        return match === undefined ? [] : [{ text, match, order }]
      })
      .sort((a, b) => b.match.score - a.match.score || a.order - b.order)
      .slice(0, 3)
      .map(({ text, match }) => snippetAround(text, match.index, match.length))
}
