import { describe, expect, it } from 'vitest'
import { findFolded, foldForSearch } from './fold.js'
import { excerpterFor, fullTextSearch, tokenize, tokenizeForIndex } from './full-text.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const doc = (documentId: string, name: string, texts: string[] = []) => ({
  documentId,
  path: documentId,
  name,
  texts,
})

describe('diacritic-insensitive matching', () => {
  it('finds an accented name by its unaccented spelling', () => {
    const docs = [doc('cafe', 'Café supplier list'), doc('other', 'Bakery')]
    expect(fullTextSearch(docs, 'cafe').map((hit) => hit.documentId)).toEqual(['cafe'])
  })

  it('finds an unaccented name by an accented query, and a capital accent too', () => {
    const docs = [doc('ops', 'Équipe Ops'), doc('plain', 'equipe roster')]
    expect(new Set(fullTextSearch(docs, 'equipe').map((hit) => hit.documentId))).toEqual(
      new Set(['ops', 'plain']),
    )
    expect(new Set(fullTextSearch(docs, 'Équipe').map((hit) => hit.documentId))).toEqual(
      new Set(['ops', 'plain']),
    )
  })

  it('folds a decomposed accent the same as a precomposed one', () => {
    expect(tokenize('café')).toEqual(tokenize('café'))
    expect(tokenize('café')).toEqual(['cafe'])
  })

  it('keeps Japanese voiced kana distinct and tokenised as before', () => {
    // A dakuten is a combining mark under NFKD; stripping it would make
    // が and か the same character.
    expect(tokenize('がっこう')).toEqual(['がっ', 'っこ', 'こう'])
    expect(tokenizeForIndex('かが')).toEqual(['か', 'が', 'かが'])
    expect(tokenize('が')).not.toEqual(tokenize('か'))
  })

  it('quotes and locates the ORIGINAL accented text in an excerpt', () => {
    const excerpt = excerpterFor('cafe')({ texts: ['Order beans from the Café du Monde today'] })
    expect(excerpt).toEqual(['Order beans from the Café du Monde today'])
    expect(findFolded('Order from the Café du Monde', 'cafe')).toEqual({ index: 15, length: 4 })
    expect(findFolded('café noir', 'café')).toEqual({ index: 0, length: 5 })
    expect(findFolded('Bakery', 'cafe')).toBeUndefined()
  })
})

// Latin letters with and without marks, a few decomposed sequences, CJK and
// voiced kana, compatibility forms, and capitals that lowercase to more than
// one code point — the inputs where folding has something to decide.
const piece = fc.constantFrom(
  'a',
  'é',
  'é',
  'É',
  'ñ',
  'Ø',
  'ß',
  'İ',
  'ﬁ',
  'Ａ',
  '①',
  '㎒',
  'が',
  'ｶﾞ',
  '検索',
  '한',
  'Σ',
  'й',
  ' ',
  '-',
  '́',
)
const text = fc.array(piece, { maxLength: 12 }).map((parts) => parts.join(''))

describe('foldForSearch', () => {
  fcTest.prop([text], withDefaults({ numRuns: 500 }))('is idempotent', (value) => {
    expect(foldForSearch(foldForSearch(value))).toBe(foldForSearch(value))
  })

  fcTest.prop([text, text], withDefaults({ numRuns: 300 }))(
    'a query equal to a folded name always finds that name',
    (before, name) => {
      if (tokenize(name).length === 0) return
      const docs = [doc('target', `${before} ${name}`)]
      expect(fullTextSearch(docs, foldForSearch(name)).map((hit) => hit.documentId)).toEqual([
        'target',
      ])
    },
  )

  fcTest.prop([text, text], withDefaults({ numRuns: 300 }))(
    'a folded match maps back to a span of the original that folds to the needle',
    (value, needle) => {
      const found = findFolded(value, needle)
      if (found === undefined) {
        const wanted = foldForSearch(needle)
        expect(wanted === '' || !foldForSearch(value).includes(wanted)).toBe(true)
        return
      }
      const span = value.slice(found.index, found.index + found.length)
      expect(foldForSearch(span)).toContain(foldForSearch(needle))
    },
  )
})
