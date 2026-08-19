// The export path draws with the vendored Roboto and nothing else
// (`loadSystemFonts: false`), so a code point Roboto has no glyph for is not
// approximated or substituted — resvg paints a tofu box. Silently. That is
// the worst shape a failure can take: layout is correct, the box is the right
// size, the wrapping is right, and the reader cannot read a word of it.
//
// The information to say so is already on hand — `charToGlyphIndex` is what
// the measurer uses to decide when to fall back to the estimator. This makes
// it an answer instead of an internal detail.
import { describe, expect, test } from 'vitest'
import { undrawableCharacters } from './undrawable-characters.js'

const CANVAS = (text: string) => ({
  nodes: [{ id: 'n', type: 'text' as const, x: 0, y: 0, width: 200, height: 60, text }],
  edges: [],
})

describe('undrawableCharacters', () => {
  test('says nothing about a canvas the export font can draw', async () => {
    expect(await undrawableCharacters(CANVAS('Hello world 123'))).toEqual([])
  })

  test('names the Japanese characters Roboto has no glyph for', async () => {
    const missing = await undrawableCharacters(CANVAS('こんにちは'))

    expect(missing).toEqual(['こ', 'ん', 'に', 'ち', 'は'])
  })

  test('reports each character once, in first-seen order, across every node', async () => {
    const missing = await undrawableCharacters({
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '漢字' },
        { id: 'b', type: 'text', x: 0, y: 20, width: 10, height: 10, text: '漢字も' },
      ],
      edges: [],
    })

    // Deterministic and de-duplicated: this is reported to an agent, and a
    // list that reshuffles between identical renders is not something anyone
    // can act on or diff.
    expect(missing).toEqual(['漢', '字', 'も'])
  })

  test('reads group labels and edge labels too, not just node text', async () => {
    const missing = await undrawableCharacters({
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, width: 100, height: 100, label: 'グループ' },
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a' },
        { id: 'b', type: 'text', x: 0, y: 20, width: 10, height: 10, text: 'b' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: '矢印' }],
    })

    expect(missing).toEqual(['グ', 'ル', 'ー', 'プ', '矢', '印'])
  })
})
