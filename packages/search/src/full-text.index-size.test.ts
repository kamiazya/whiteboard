// What one document contributes to the index, counted. The daemon searches a
// whole workspace per call and a body may be MARKDOWN_MAX_CHARS long, so the
// size of one document's terms is multiplied by the workspace's document
// ceiling — counted rather than heap-measured, because a count is the same on
// every machine and a heap figure is not.

import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_TERMS_MAX, documentTerms, fullTextSearch, tokenizeForIndex } from './full-text.js'
import { randomCjk } from './test-utils/random-cjk.js'

describe('tokenizeForIndex size', () => {
  it('emits one unigram and one bigram per character of a maximal random-CJK body', () => {
    const tokens = tokenizeForIndex(randomCjk(MARKDOWN_MAX_CHARS))
    expect(tokens).toHaveLength(MARKDOWN_MAX_CHARS + (MARKDOWN_MAX_CHARS - 1))
    // Almost every bigram is distinct: about 283,000 keys, which is what a
    // document's terms would hold without DOCUMENT_TERMS_MAX.
    expect(new Set(tokens).size).toBeGreaterThan(250_000)
  })
})

describe('documentTerms ceiling', () => {
  it('holds at most DOCUMENT_TERMS_MAX distinct terms for a maximal random-CJK body', () => {
    const terms = documentTerms({ path: 'd', texts: [randomCjk(MARKDOWN_MAX_CHARS)] })
    expect(terms.counts.size).toBeLessThanOrEqual(DOCUMENT_TERMS_MAX)
    // The subject is present: the ceiling is what stopped it, not a short body.
    expect(terms.counts.size).toBeGreaterThan(DOCUMENT_TERMS_MAX / 2)
  })

  it('indexes every token of a document whose vocabulary is under the ceiling', () => {
    const body = '検索基盤の日程を確定する。QA完了後に共有します。'.repeat(10_000)
    const terms = documentTerms({ path: 'plans/q3', name: 'Q3', texts: [body] })
    const every = [
      ...tokenizeForIndex('plans/q3'),
      ...tokenizeForIndex('Q3'),
      ...tokenizeForIndex(body),
    ]
    expect(terms.length).toBe(every.length)
    expect(terms.counts.size).toBe(new Set(every).size)
  })

  it('keeps the name findable when the body alone would exceed the ceiling', () => {
    const doc = {
      documentId: 'a',
      path: 'notes/a',
      name: 'ロケット計画',
      texts: [randomCjk(MARKDOWN_MAX_CHARS)],
    }
    expect(fullTextSearch([doc], 'ロケット').map((hit) => hit.documentId)).toEqual(['a'])
  })

  it('stops at the ceiling, so a word first written after it does not find the document', () => {
    const doc = { documentId: 'a', path: 'a', texts: [randomCjk(MARKDOWN_MAX_CHARS), 'a zeppelin'] }
    const terms = documentTerms(doc)
    expect(terms.counts.has('zeppelin')).toBe(false)
    // Stopped, not skipping: a term already held is not counted again past
    // the ceiling either, in this text or any later one.
    expect(terms.counts.get('a')).toBe(1)
    expect(terms.length).toBeLessThan(2 * DOCUMENT_TERMS_MAX)
  })
})

describe('fullTextSearch termsOf', () => {
  it('reuses terms a caller built once instead of indexing the documents again per query', () => {
    let indexed = 0
    const alsoIndex = (_text: string) => {
      indexed++
      return ''
    }
    const docs = [
      { documentId: 'a', path: 'a', texts: ['rocket launch window'] },
      { documentId: 'b', path: 'b', texts: ['launch checklist'] },
    ]
    const held = new Map(docs.map((doc) => [doc.documentId, documentTerms(doc, alsoIndex)]))
    const afterBuild = indexed
    expect(afterBuild).toBeGreaterThan(0)

    const termsOf = (doc: { documentId: string }) => {
      const terms = held.get(doc.documentId)
      if (terms === undefined) throw new Error(`no terms held for ${doc.documentId}`)
      return terms
    }
    const first = fullTextSearch(docs, 'launch', { alsoIndex, termsOf })
    const second = fullTextSearch(docs, 'rocket launch', { alsoIndex, termsOf })
    expect(indexed).toBe(afterBuild)
    expect(first).toEqual(fullTextSearch(docs, 'launch'))
    expect(second).toEqual(fullTextSearch(docs, 'rocket launch'))
  })
})
