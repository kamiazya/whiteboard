import { describe, expect, it } from 'vitest'
import { parseMarkdownBody } from './pipeline.js'

// micromark is patched to remember which open token made the previous lazy
// line part of something, instead of rescanning the whole flow on every lazy
// line. These pin what a lazy line means, so a remembered answer that went
// stale would show here as a changed tree.
describe('parseMarkdownBody lazy continuation', () => {
  it('continues a quoted paragraph across lazy lines', () => {
    expect(parseMarkdownBody('> a\nb\nc').children).toEqual([
      {
        type: 'blockquote',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'a\nb\nc' }] }],
      },
    ])
  })

  it('ends the quote at a lazy line that a fenced code block cannot take', () => {
    expect(parseMarkdownBody('> ~~~c\nd').children).toEqual([
      { type: 'blockquote', children: [{ type: 'code', lang: 'c', value: '' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'd' }] },
    ])
  })

  it('ends the quote at a lazy line after the paragraph a lazy line once continued', () => {
    // The second lazy line comes after the paragraph the first one continued
    // has closed, so what made the first one lazy no longer says anything.
    expect(parseMarkdownBody('> a\nb\n> ~~~\nc').children).toEqual([
      {
        type: 'blockquote',
        children: [
          { type: 'paragraph', children: [{ type: 'text', value: 'a\nb' }] },
          { type: 'code', value: '' },
        ],
      },
      { type: 'paragraph', children: [{ type: 'text', value: 'c' }] },
    ])
  })

  it('reads a would-be table unmade by a lazy line as one quoted paragraph', () => {
    expect(parseMarkdownBody('> | e |\nf').children).toEqual([
      {
        type: 'blockquote',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '| e |\nf' }] }],
      },
    ])
  })
})
