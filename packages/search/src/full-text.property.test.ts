import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import {
  EXCERPT_TOKENS_MAX,
  excerpterFor,
  fullTextSearch,
  type SearchableDocument,
} from './full-text.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

// A five-word vocabulary keeps the corpus dense: most queries hit several
// documents, and a document's texts often hold the query both verbatim and
// scattered, which is where excerpt ordering has something to decide.
const word = fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'plan')
const phrase = (maxLength: number) =>
  fc.array(word, { minLength: 1, maxLength }).map((words) => words.join(' '))

// Texts run up to thirty words so some pass the excerpt radius, where a match
// that starts one unit earlier moves the cut and changes the excerpt itself.
const corpus = fc
  .array(fc.array(phrase(30), { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 6 })
  .map((docs): SearchableDocument[] =>
    docs.map((texts, i) => ({ documentId: `d${i}`, path: `d${i}`, texts })),
  )

const query = phrase(3)

const tally = { answered: 0, verbatimAmongSeveral: 0 }

describe('fullTextSearch query normalisation', () => {
  // Query tokens are a SET: a word typed twice is the same request, so it
  // must not weigh double in any document's score.
  fcTest.prop([corpus, query], withDefaults({ numRuns: 200 }))(
    'ranks and scores a repeated query exactly as the query once',
    (docs, q) => {
      const once = fullTextSearch(docs, q)
      const twice = fullTextSearch(docs, `${q} ${q}`)
      if (once.length > 0) tally.answered++
      const ranked = (hits: typeof once) =>
        hits.map(({ documentId, score }) => ({ documentId, score }))
      expect(ranked(twice)).toEqual(ranked(once))
    },
  )

  // Whitespace around a query is not part of what was asked for, so it must
  // change neither the ranking nor which excerpt is quoted where.
  fcTest.prop([corpus, query], withDefaults({ numRuns: 200 }))(
    'answers a query padded with spaces exactly as the bare query',
    (docs, q) => {
      for (const doc of docs) {
        const matching = doc.texts.filter((t) => q.split(' ').some((w) => t.includes(w)))
        if (matching.length > 1 && matching.some((t) => t.includes(q))) {
          tally.verbatimAmongSeveral++
          break
        }
      }
      expect(fullTextSearch(docs, ` ${q} `)).toEqual(fullTextSearch(docs, q))
    },
  )

  afterAllFloor(
    [
      'ranks and scores a repeated query exactly as the query once',
      'answers a query padded with spaces exactly as the bare query',
    ],
    () => {
      // Without hits both properties hold of two empty arrays; without a
      // document whose verbatim text competes with partial ones, excerpt
      // order is never decided by the needle.
      expect(tally.answered).toBeGreaterThan(150)
      expect(tally.verbatimAmongSeveral).toBeGreaterThan(80)
    },
  )
})

const splitTally = { excerpted: 0 }

describe('fullTextSearch excerpts cut apart from ranking', () => {
  // A caller whose page is not a prefix of the ranking (fusion) ranks with
  // excerpts off and excerpts its page itself; that must answer what the
  // inline path does, in order, score and excerpt alike.
  fcTest.prop([corpus, query], withDefaults({ numRuns: 200 }))(
    'answers the same hits and excerpts as excerpting inline',
    (docs, q) => {
      const inline = fullTextSearch(docs, q, { limit: docs.length })
      const ranked = fullTextSearch(docs, q, { limit: docs.length, excerpts: false })
      const excerpt = excerpterFor(q)
      const byId = new Map(docs.map((doc) => [doc.documentId, doc]))
      expect(ranked.every((hit) => hit.contexts.length === 0)).toBe(true)
      const split = ranked.map((hit) => {
        const doc = byId.get(hit.documentId)
        return { ...hit, contexts: doc === undefined ? [] : excerpt(doc) }
      })
      if (split.some((hit) => hit.contexts.length > 0)) splitTally.excerpted++
      expect(split).toEqual(inline)
    },
  )

  afterAllFloor(['answers the same hits and excerpts as excerpting inline'], () => {
    // Without an excerpt the comparison holds of empty contexts alone.
    expect(splitTally.excerpted).toBeGreaterThan(150)
  })
})

describe('fullTextSearch excerpt token bound', () => {
  const words = Array.from({ length: EXCERPT_TOKENS_MAX + 1 }, (_, i) => `w${i}x`)

  it('ranks on a token past the bound but quotes no excerpt for it', () => {
    const doc = { documentId: 'a', path: 'a', texts: [`only ${words.at(-1)} here`] }
    const [hit] = fullTextSearch([doc], words.join(' '))
    expect(hit?.score).toBeGreaterThan(0)
    expect(hit?.contexts).toEqual([])
  })

  it('quotes an excerpt for the last token inside the bound', () => {
    const doc = { documentId: 'a', path: 'a', texts: [`only ${words.at(-2)} here`] }
    const [hit] = fullTextSearch([doc], words.join(' '))
    expect(hit?.contexts).toEqual([`only ${words.at(-2)} here`])
  })
})

describe('fullTextSearch excerpt order', () => {
  it('quotes a verbatim text ahead of an earlier one holding every query word scattered', () => {
    const [hit] = fullTextSearch(
      [{ documentId: 'a', path: 'a', texts: ['plan the launch', 'launch plan'] }],
      'launch plan',
    )
    expect(hit?.contexts).toEqual(['launch plan', 'plan the launch'])
  })
})

describe('fullTextSearch score', () => {
  // Both documents are one path token plus one text token, so each sits at the
  // average length and BM25's term-frequency factor is exactly 1: the score is
  // the IDF alone, ln(1 + (N - n + 0.5) / (n + 0.5)) with N = 2 and n = 1.
  it('scores a term one of two equal-length documents holds once at ln 2', () => {
    const [hit] = fullTextSearch(
      [
        { documentId: 'a', path: 'a', texts: ['rocket'] },
        { documentId: 'b', path: 'b', texts: ['filler'] },
      ],
      'rocket',
    )
    expect(hit?.score).toBeCloseTo(Math.LN2, 12)
  })
})
