import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { fullTextSearch, tokenize } from './full-text.js'

describe('tokenize', () => {
  it('turns Japanese runs into adjacent character bigrams', () => {
    expect(tokenize('検索基盤')).toEqual(['検索', '索基', '基盤'])
  })

  it('turns latin runs into lowercased words', () => {
    expect(tokenize('Full-Text SEARCH')).toEqual(['full', 'text', 'search'])
  })

  it('handles mixed text and single CJK characters, and never yields empty tokens', () => {
    // Hiragana is CJK too: particles cost noise bigrams, but dropping the
    // script would lose every hiragana word. Scripts still split (bm25 is
    // its own token, not glued to the kana).
    expect(tokenize('BM25で検索')).toEqual(['bm25', 'で検', '検索'])
    expect(tokenize('図')).toEqual(['図'])
    for (const token of tokenize('  ,, 。 a ')) expect(token.length).toBeGreaterThan(0)
  })
})

const DOC = (
  documentId: string,
  texts: string[],
  extra: Partial<{ name: string; path: string }> = {},
) => ({
  documentId,
  path: extra.path ?? documentId,
  ...(extra.name === undefined ? {} : { name: extra.name }),
  texts,
})

describe('fullTextSearch', () => {
  it('ranks a body match above documents without the term, with a snippet around the hit', () => {
    const results = fullTextSearch(
      [DOC('a', ['QA完了後に検索基盤の日程を確定する。']), DOC('b', ['まったく関係のない本文。'])],
      '検索基盤',
    )
    expect(results.map((r) => r.documentId)).toEqual(['a'])
    expect(results[0]?.contexts[0]).toContain('検索基盤')
  })

  it('matches latin queries case-insensitively', () => {
    const results = fullTextSearch([DOC('a', ['Tune the BM25 scoring constants.'])], 'bm25')
    expect(results.map((r) => r.documentId)).toEqual(['a'])
  })

  it('matches names and paths, not only bodies', () => {
    const results = fullTextSearch(
      [DOC('a', [], { name: 'Release plan' }), DOC('b', [], { path: 'plans/roadmap' })],
      'release',
    )
    expect(results.map((r) => r.documentId)).toEqual(['a'])
    expect(fullTextSearch([DOC('b', [], { path: 'plans/roadmap' })], 'roadmap')).toHaveLength(1)
  })

  it('answers nothing for an empty or no-hit query', () => {
    expect(fullTextSearch([DOC('a', ['text'])], '')).toEqual([])
    expect(fullTextSearch([DOC('a', ['text'])], 'absent')).toEqual([])
  })

  fcTest.prop(
    [fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 })],
    withDefaults({ numRuns: 60 }),
  )(
    'adding occurrences of a query term never lowers that document score (tf monotonicity)',
    (base, extra) => {
      const term = '検索'
      const body = (n: number) => [`${'関係ない前置き。'.repeat(2)}${term.repeat(n)}`]
      const others = [DOC('x', ['別の文書の本文がここにある。'])]
      const score = (n: number) =>
        fullTextSearch([DOC('a', body(n)), ...others], term).find((r) => r.documentId === 'a')
          ?.score ?? 0
      expect(score(base + extra)).toBeGreaterThanOrEqual(score(base))
    },
  )
})
