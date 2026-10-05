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
  return tokenizeRuns(text, false)
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
  return tokenizeRuns(text, true)
}

function tokenizeRuns(text: string, unigrams: boolean): string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const run = match[0]
    // Split the run into CJK and non-CJK stretches: "bm25で検索" arrives as
    // one \p{L}\p{N} run, and word-tokenizing it whole would glue the
    // scripts together into a token nobody types.
    let latin = ''
    let cjk = ''
    const flushLatin = () => {
      if (latin !== '') tokens.push(latin)
      latin = ''
    }
    const flushCjk = () => {
      if (unigrams || cjk.length === 1) for (const char of cjk) tokens.push(char)
      for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk.slice(i, i + 2))
      cjk = ''
    }
    for (const char of run) {
      if (CJK.test(char)) {
        flushLatin()
        cjk += char
      } else {
        flushCjk()
        latin += char
      }
    }
    flushLatin()
    flushCjk()
  }
  return tokens
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
 * derived text must never reach `contextsFor` — a hit on a word the reader
 * cannot see in their own note is confusing enough without the excerpt
 * inventing it.
 */
export type AlsoIndex = (text: string) => string

function addTo(text: string, alsoIndex: AlsoIndex): string {
  const extra = alsoIndex(text)
  return extra === '' ? text : `${text} ${extra}`
}

interface TokenBag {
  readonly doc: SearchableDocument
  /** How often each index token occurs across the document's path, name and texts. */
  readonly counts: ReadonlyMap<string, number>
  readonly length: number
}

function tokenBag(doc: SearchableDocument, alsoIndex: AlsoIndex | undefined): TokenBag {
  const counts = new Map<string, number>()
  let length = 0
  for (const text of [doc.path, doc.name ?? '', ...doc.texts]) {
    for (const token of tokenizeForIndex(alsoIndex === undefined ? text : addTo(text, alsoIndex))) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
      length++
    }
  }
  return { doc, counts, length }
}

/**
 * BM25 over the documents' token bags, name and path included as text (a
 * query naming a document should find it without the caller special-casing
 * fields). Scores are relative to THIS corpus — never compare across calls.
 */
export function fullTextSearch(
  documents: readonly SearchableDocument[],
  query: string,
  { limit = 10, alsoIndex }: { limit?: number; alsoIndex?: AlsoIndex } = {},
): SearchHit[] {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0) return []

  const bags = documents.map((doc) => tokenBag(doc, alsoIndex))
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
  return scored.slice(0, limit).map(({ doc, score }) => ({
    documentId: doc.documentId,
    score,
    contexts: contextsFor(doc, query),
  }))
}

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
 */
function contextsFor(doc: SearchableDocument, query: string): string[] {
  const needle = query.trim().toLowerCase()
  const tokens = [...new Set(tokenize(query))]
  return doc.texts
    .flatMap((text, order) => {
      const match = firstMatch(text.toLowerCase(), needle, tokens)
      return match === undefined ? [] : [{ text, match, order }]
    })
    .sort((a, b) => b.match.score - a.match.score || a.order - b.order)
    .slice(0, 3)
    .map(({ text, match }) => snippetAround(text, match.index, match.length))
}
