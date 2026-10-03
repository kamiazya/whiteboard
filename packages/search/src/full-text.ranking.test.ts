import { describe, expect, it } from 'vitest'
import { fullTextSearch } from './full-text.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const DOC = (documentId: string, texts: string[]) => ({ documentId, path: documentId, texts })
const ids = (hits: readonly { documentId: string }[]) => hits.map((h) => h.documentId)

describe('fullTextSearch ranking', () => {
  it('ranks the denser match first even when its id sorts later', () => {
    const docs = [
      DOC('a', ['rocket and a lot of other words in this long text about nothing in particular']),
      DOC('z', ['rocket rocket rocket']),
    ]
    expect(ids(fullTextSearch(docs, 'rocket'))).toEqual(['z', 'a'])
  })

  it('breaks equal scores by documentId ascending, whatever the input order', () => {
    const docs = [DOC('b', ['rocket']), DOC('c', ['rocket']), DOC('a', ['rocket'])]
    expect(ids(fullTextSearch(docs, 'rocket'))).toEqual(['a', 'b', 'c'])
  })

  it('keeps the best hits under a limit, not the first ones', () => {
    const docs = [DOC('a', ['rocket x x x x x x x x x']), DOC('b', ['rocket rocket rocket'])]
    expect(ids(fullTextSearch(docs, 'rocket', { limit: 1 }))).toEqual(['b'])
  })

  it('returns no more hits than the limit', () => {
    const docs = Array.from({ length: 5 }, (_, i) => DOC(`d${i}`, ['rocket']))
    expect(fullTextSearch(docs, 'rocket', { limit: 2 })).toHaveLength(2)
  })

  it('weighs a term few documents hold above one most documents hold', () => {
    const common = Array.from({ length: 5 }, (_, i) => DOC(`c${i}`, ['common']))
    const docs = [...common, DOC('x', ['common']), DOC('y', ['rare'])]
    expect(ids(fullTextSearch(docs, 'common rare'))[0]).toBe('y')
  })

  it('ranks the shorter document first when both hold the term once', () => {
    const docs = [DOC('a', [`rocket ${'filler '.repeat(30)}`]), DOC('z', ['rocket'])]
    expect(ids(fullTextSearch(docs, 'rocket'))).toEqual(['z', 'a'])
  })

  // Total length is held fixed (the rest of each document is filler) because BM25
  // normalises by document length: with the length equal, the term frequency is the
  // only thing the two documents differ in, so a denser document must outrank the
  // sparser one whatever order their ids sort in.
  fcTest.prop(
    [
      fc.integer({ min: 2, max: 12 }),
      fc.integer({ min: 1, max: 11 }),
      fc.boolean(),
      fc.integer({ min: 0, max: 3 }),
    ],
    withDefaults({ numRuns: 100 }),
  )(
    'ranks a document with more occurrences of the term first when total length is equal',
    (length, sparse, denseIdFirst, bystanders) => {
      fc.pre(sparse < length)
      const dense = sparse + 1
      const body = (hits: number) => [
        [
          ...Array.from({ length: hits }, () => 'rocket'),
          ...Array.from({ length: length - hits }, () => 'filler'),
        ].join(' '),
      ]
      const [denseId, sparseId] = denseIdFirst ? ['a', 'b'] : ['z', 'y']
      const unrelated = Array.from({ length: bystanders }, (_, i) => DOC(`u${i}`, ['filler']))
      const hits = fullTextSearch(
        [DOC(sparseId, body(sparse)), DOC(denseId, body(dense)), ...unrelated],
        'rocket',
      )
      expect(ids(hits)).toEqual([denseId, sparseId])
    },
  )
})

describe('fullTextSearch excerpts', () => {
  it('quotes at most three contexts', () => {
    const [hit] = fullTextSearch(
      [DOC('a', ['rocket 1', 'rocket 2', 'rocket 3', 'rocket 4', 'rocket 5'])],
      'rocket',
    )
    expect(hit?.contexts).toHaveLength(3)
  })

  it('centres a query that only matches token-wise on its earliest matching token', () => {
    const text = `alpha ${'filler '.repeat(60)}beta`
    const [hit] = fullTextSearch([DOC('a', [text])], 'beta alpha')
    expect(hit?.contexts[0]).toContain('alpha')
    expect(hit?.contexts[0]).not.toContain('beta')
  })

  it('quotes the text holding the whole query ahead of earlier texts that hold part of it', () => {
    const [hit] = fullTextSearch(
      [DOC('a', ['alpha one', 'alpha again', 'beta two', 'alpha two exact', 'alpha last'])],
      'alpha two exact',
    )
    expect(hit?.contexts).toHaveLength(3)
    expect(hit?.contexts[0]).toBe('alpha two exact')
  })

  it('quotes the text matching more of the query ahead of one matching less, in document order within a tie', () => {
    const [hit] = fullTextSearch(
      [DOC('a', ['alpha', 'beta', 'gamma beta alpha', 'alpha beta gamma', 'delta'])],
      'gamma beta alpha delta',
    )
    expect(hit?.contexts).toEqual(['gamma beta alpha', 'alpha beta gamma', 'alpha'])
  })

  it('counts a word the query repeats once', () => {
    const [hit] = fullTextSearch([DOC('a', ['alpha', 'beta gamma'])], 'alpha alpha beta gamma')
    expect(hit?.contexts).toEqual(['beta gamma', 'alpha'])
  })

  // The planted text is the only one holding the query verbatim in some runs
  // and one of several in others; either way a document that holds it
  // verbatim must quote it, wherever it sits among the texts.
  fcTest.prop(
    [
      fc.array(
        fc
          .array(fc.constantFrom('alpha', 'two', 'exact', 'beta', 'one'), {
            minLength: 1,
            maxLength: 3,
          })
          .map((words) => words.join(' ')),
        { minLength: 0, maxLength: 8 },
      ),
      fc.nat(8),
    ],
    withDefaults({ numRuns: 100 }),
  )('quotes a text holding the query verbatim whenever the document has one', (others, slot) => {
    const needle = 'alpha two exact'
    const texts = [...others.slice(0, slot), needle, ...others.slice(slot)]
    const [hit] = fullTextSearch([DOC('a', texts)], needle)
    expect(hit?.contexts).toContain(needle)
  })

  it('indexes derived text but never quotes it', () => {
    const [hit] = fullTextSearch([DOC('a', ['\u{1F680} launch'])], 'rocket', {
      alsoIndex: (t) => (t.includes('\u{1F680}') ? 'rocket' : ''),
    })
    expect(hit?.documentId).toBe('a')
    expect(hit?.contexts).toEqual([])
  })

  it('indexes text as it is when nothing is derived from it', () => {
    const hits = fullTextSearch([DOC('a', ['plain words'])], 'plain', { alsoIndex: () => '' })
    expect(ids(hits)).toEqual(['a'])
  })
})
