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
 * BM25 over the documents' token bags, name and path included as text (a
 * query naming a document should find it without the caller special-casing
 * fields). Scores are relative to THIS corpus — never compare across calls.
 */
export function fullTextSearch(
  documents: readonly SearchableDocument[],
  query: string,
  { limit = 10 }: { limit?: number } = {},
): SearchHit[] {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0) return []

  const bags = documents.map((doc) => {
    const counts = new Map<string, number>()
    let length = 0
    for (const text of [doc.path, doc.name ?? '', ...doc.texts]) {
      for (const token of tokenizeForIndex(text)) {
        counts.set(token, (counts.get(token) ?? 0) + 1)
        length++
      }
    }
    return { doc, counts, length }
  })
  const avgLength = bags.reduce((sum, bag) => sum + bag.length, 0) / Math.max(1, bags.length)

  const hits: SearchHit[] = []
  for (const bag of bags) {
    let score = 0
    for (const token of queryTokens) {
      const tf = bag.counts.get(token) ?? 0
      if (tf === 0) continue
      const containing = bags.filter((other) => (other.counts.get(token) ?? 0) > 0).length
      const idf = Math.log(1 + (bags.length - containing + 0.5) / (containing + 0.5))
      score +=
        (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * bag.length) / Math.max(1, avgLength)))
    }
    if (score <= 0) continue
    hits.push({ documentId: bag.doc.documentId, score, contexts: contextsFor(bag.doc, query) })
  }
  return hits
    .sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId))
    .slice(0, limit)
}

/**
 * Excerpts, keyed on the RAW query string when it occurs verbatim (the
 * common case, and the most readable snippet); a query that only matches
 * token-wise falls back to the first matching token's position.
 */
function contextsFor(doc: SearchableDocument, query: string): string[] {
  const needle = query.trim().toLowerCase()
  const tokens = tokenize(query)
  const contexts: string[] = []
  for (const text of doc.texts) {
    const lower = text.toLowerCase()
    let index = needle === '' ? -1 : lower.indexOf(needle)
    let length = needle.length
    if (index === -1) {
      for (const token of tokens) {
        const at = lower.indexOf(token)
        if (at !== -1 && (index === -1 || at < index)) {
          index = at
          length = token.length
        }
      }
    }
    if (index !== -1) contexts.push(snippetAround(text, index, length))
    if (contexts.length >= 3) break
  }
  return contexts
}
