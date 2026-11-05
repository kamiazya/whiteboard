import { describe, expect, it } from 'vitest'
import { excerpterFor, fullTextSearch } from './full-text.js'
import { CONTEXT_RADIUS, linkLabelsFrom, snippetAround } from './snippet.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const LINK = '[[folder/deep-learning/transformer]]'
const labels = new Map([['folder/deep-learning/transformer', 'Transformer']])
const labelOf = (target: string) => labels.get(target)

describe('snippetAround over [[links]]', () => {
  it('shows a link as its target’s display name, the match included', () => {
    const text = `基盤は ${LINK} のエンコーダ`
    // The "Linked from" case: the match IS the link.
    expect(snippetAround(text, text.indexOf(LINK), LINK.length, labelOf)).toBe(
      '基盤は Transformer のエンコーダ',
    )
    // The search case: the match is inside the link's path.
    expect(snippetAround(text, text.indexOf('deep'), 4, labelOf)).toBe(
      '基盤は Transformer のエンコーダ',
    )
  })

  it('shows an embed, an alias and a heading as a reader would', () => {
    expect(snippetAround(`see ![[${LINK.slice(2)} here`, 0, 3, labelOf)).toBe(
      'see Transformer here',
    )
    expect(snippetAround('see [[folder/deep-learning/transformer|the paper]]', 0, 3, labelOf)).toBe(
      'see the paper',
    )
    expect(snippetAround('see [[folder/deep-learning/transformer#Attention]]', 0, 3, labelOf)).toBe(
      'see Transformer › Attention',
    )
  })

  it('falls back to the last segment of a target nobody named', () => {
    expect(snippetAround('see [[notes/unnamed-thing]] now', 0, 3)).toBe('see unnamed-thing now')
  })

  it('labels a link by path or by id from a listing', () => {
    const labelOfListing = linkLabelsFrom([
      { documentId: '01HID', path: 'folder/deep-learning/transformer', name: 'Transformer' },
      { documentId: '01HUNNAMED', path: 'notes/plain-note' },
    ])
    expect(snippetAround(`a ${LINK} b`, 0, 1, labelOfListing)).toBe('a Transformer b')
    expect(snippetAround('a [[01HID]] b', 0, 1, labelOfListing)).toBe('a Transformer b')
    expect(snippetAround('a [[01HUNNAMED]] b', 0, 1, labelOfListing)).toBe('a plain-note b')
  })

  it('never cuts inside a link at either edge', () => {
    const pad = 'x'.repeat(CONTEXT_RADIUS - 5)
    const text = `${LINK} ${pad} match ${pad} ${LINK}`
    const at = text.indexOf('match')
    const snippet = snippetAround(text, at, 5, labelOf)
    expect(snippet).not.toMatch(/\[\[|\]\]|deep-lea|transfor(?!mer)/)
    expect(snippet).toBe(`…${pad} match ${pad}…`)
  })

  const filler = fc.constantFrom('a', ' ', 'b c', '検索', '\n')
  const piece = fc.oneof(
    filler,
    fc.constant(LINK),
    fc.constant('![[notes/x]]'),
    fc.constant('[[p|alias]]'),
  )
  const body = fc.array(piece, { minLength: 1, maxLength: 80 }).map((parts) => parts.join(''))

  fcTest.prop([body, fc.nat(), fc.integer({ min: 1, max: 6 })], withDefaults({ numRuns: 300 }))(
    'never shows a fragment of link markup',
    (text, rawAt, length) => {
      const at = rawAt % text.length
      const snippet = snippetAround(text, at, Math.min(length, text.length - at), labelOf)
      expect(snippet).not.toMatch(/\[\[|\]\]|\[|\]/)
    },
  )
})

describe('fullTextSearch excerpts over [[links]]', () => {
  it('quote a link by the label the caller gives it', () => {
    const doc = { documentId: 'a', path: 'a', texts: [`attention in ${LINK} matters`] }
    const [hit] = fullTextSearch([doc], 'attention', { linkLabel: labelOf })
    expect(hit?.contexts).toEqual(['attention in Transformer matters'])
    expect(excerpterFor('attention', labelOf)(doc)).toEqual(['attention in Transformer matters'])
  })
})
