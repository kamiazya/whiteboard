import { describe, expect, it } from 'vitest'
import { parseMarkdownBody } from './pipeline.js'

// GFM parses footnotes, but the model has no footnote nodes. A node kind the
// converter does not know degrades to its `value`, and a footnote reference or
// definition has none, so without an explicit case both vanish.
describe('parseMarkdownBody footnotes', () => {
  it('keeps a footnote reference as literal text beside the word before it', () => {
    const tree = parseMarkdownBody('word[^1] and more\n\n[^1]: the note')
    expect(tree.children[0]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', value: 'word' },
        { type: 'text', value: '[^1]' },
        { type: 'text', value: ' and more' },
      ],
    })
  })

  it('keeps a footnote definition as a paragraph that reads [^label]: text', () => {
    const tree = parseMarkdownBody('word[^1]\n\n[^1]: the *note*')
    expect(tree.children[1]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', value: '[^1]: ' },
        { type: 'text', value: 'the ' },
        { type: 'emphasis', children: [{ type: 'text', value: 'note' }] },
      ],
    })
  })

  it('keeps the text of a multi-block definition rather than dropping it', () => {
    const tree = parseMarkdownBody('word[^a]\n\n[^a]: first\n\n    second')
    const flat = JSON.stringify(tree.children[1])
    expect(flat).toContain('first')
    expect(flat).toContain('second')
  })
})
