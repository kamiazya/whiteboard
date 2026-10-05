// What one query costs as the corpus and the query grow. Search runs on
// every keystroke the box debounces and on every agent call, so a cost that
// grows faster than corpus × query is paid in seconds on a few hundred notes.
//
// Counted rather than timed: the work is reads of the per-document token
// bags and lowercasings of document text, which are deterministic, so the
// bound holds on any machine and a regression reads as a count rather than
// as a slow run.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fullTextSearch, type SearchableDocument } from './full-text.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const QUERY_WORDS = Array.from({ length: 50 }, (_, i) => `word${i}`)

/** Every document holds every query word, so every (document, word) pair matches. */
function corpus(documents: number): SearchableDocument[] {
  return Array.from({ length: documents }, (_, i) => ({
    documentId: `d${String(i).padStart(4, '0')}`,
    path: `notes/d${i}`,
    texts: [QUERY_WORDS.join(' '), `paragraph ${i} of nothing in particular`],
  }))
}

function counting<T>(
  target: object,
  methods: readonly string[],
  run: () => T,
): { result: T; calls: number } {
  const spies = methods.map((method) => vi.spyOn(target as Record<string, () => unknown>, method))
  const result = run()
  const calls = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
  for (const spy of spies) spy.mockRestore()
  return { result, calls }
}

describe('fullTextSearch cost', () => {
  it('reads each bag a bounded number of times per query word, not once per other document', () => {
    const documents = 200
    const { result, calls } = counting(Map.prototype, ['get', 'has'], () =>
      fullTextSearch(corpus(documents), QUERY_WORDS.join(' ')),
    )
    // The subject is present: every document matched.
    expect(result).toHaveLength(10)
    // Building the bags reads each indexed token once; scoring and document
    // frequency read each (document, query word) pair once more apiece.
    // Recomputing document frequency per matching pair is documents² ×
    // words — 2,000,000 reads here against about 31,000.
    const indexedTokens = documents * (QUERY_WORDS.length + 8)
    expect(calls).toBeLessThan(indexedTokens + 3 * documents * QUERY_WORDS.length)
  })

  it('excerpts only the documents it answers', () => {
    const documents = 200
    const { calls } = counting(String.prototype, ['toLowerCase'], () =>
      fullTextSearch(corpus(documents), 'word1', { limit: 5 }),
    )
    // Indexing lowercases each text once. Excerpting lowercases each text of
    // a document again — so excerpting all 200 matches before keeping 5
    // doubles the count, where excerpting the 5 kept adds a handful.
    const textsPerDocument = 4 // path, name, two texts
    expect(calls).toBeLessThan(documents * textsPerDocument + 5 * 10)
  })
})
