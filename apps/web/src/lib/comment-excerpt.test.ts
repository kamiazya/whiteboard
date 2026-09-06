// The rail row's one-line summary of a comment. Node, not a browser: it is a
// string transform with no DOM in it.
import { describe, expect, it } from 'vitest'
import { commentExcerpt } from './comment-excerpt.js'

it('says what the body says, without the syntax that says how to draw it', () => {
  expect(commentExcerpt('**tighten** the copy here')).toBe('tighten the copy here')
  expect(commentExcerpt('a `code` span and a [link](http://x)')).toBe('a code span and a link')
})

it('does not invent a space markdown never had inside a word', () => {
  // `a**b**c` is one word with an emphasised middle. An excerpt that spaced
  // every inline node would report three.
  expect(commentExcerpt('a**b**c')).toBe('abc')
})

it('turns a block boundary into the space a one-line summary needs', () => {
  expect(commentExcerpt('# Ship it\n\nafter review')).toBe('Ship it after review')
  expect(commentExcerpt('- one\n- two')).toBe('one two')
})

it("carries an image's alt text, which is the only thing it says", () => {
  expect(commentExcerpt('before ![the failing chart](x.png) after')).toBe(
    'before the failing chart after',
  )
})

describe('a body it cannot parse', () => {
  it('falls back to the source, which beats an empty row', () => {
    // Reaching this needs a body codec's parse rejects; the point of the
    // branch is that the row still identifies its conversation.
    expect(commentExcerpt('plain enough')).toBe('plain enough')
  })
})

it('answers the empty string for a body with nothing in it', () => {
  expect(commentExcerpt('')).toBe('')
  expect(commentExcerpt('\n\n')).toBe('')
})
