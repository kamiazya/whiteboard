// The rail row's one-line summary of a comment. Node, not a browser: it is a
// string transform with no DOM in it. The jsdom realm boots the real Rust core
// (`vitest.layout-core.setup.ts`), so these run through the artifact.
import { installSearchCore } from '@kamiazya/whiteboard-search'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('a realm with no core, or a body the core refuses', () => {
  let realm: ReturnType<typeof installSearchCore>
  afterEach(() => {
    installSearchCore(realm)
  })

  it('shows the trimmed source, which beats an empty row', () => {
    realm = installSearchCore(undefined)
    expect(commentExcerpt('  **tighten** it \n')).toBe('**tighten** it')
  })

  it("shows the trimmed source for a body past the core's request cap", () => {
    const huge = `  ${'x'.repeat(9 * 1024 * 1024)}  `
    expect(commentExcerpt(huge)).toBe(huge.trim())
  })
})

it('reads nested lists, a table and CJK as the core does', () => {
  expect(commentExcerpt('- a\n  - b\n- c')).toBe('a b c')
  expect(commentExcerpt('| a | b |\n|---|---|\n| c | d |')).toBe('ab cd')
  expect(commentExcerpt('# 見出し\n\n**太字**です')).toBe('見出し 太字です')
})

it('answers the empty string for a body with nothing in it', () => {
  expect(commentExcerpt('')).toBe('')
  expect(commentExcerpt('\n\n')).toBe('')
})
