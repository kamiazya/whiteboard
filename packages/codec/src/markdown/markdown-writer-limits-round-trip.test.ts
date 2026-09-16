import { describe, expect, it } from 'vitest'
import { parseMarkdownBody, stringifyMarkdownBody } from './pipeline.js'

/**
 * Pins the upstream writer limitations the round-trip property excludes,
 * so each exclusion is dropped the day it stops holding.
 *
 * A heading of depth 3 and up can only be ATX — one line — and
 * `mdast-util-to-markdown` encodes a line ending in its TEXT as `&#xA;`.
 * A code span or inline math cannot carry a character reference, so the
 * line ending is written raw there, and the parser reads a heading that
 * ends at the line ending plus a paragraph holding the rest. Depths 1 and
 * 2 fall back to setext, which spans lines, and survive.
 */
describe('a line ending inside a code span inside an ATX-only heading', () => {
  it('is written raw by mdast-util-to-markdown and splits the heading on re-parse', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'heading' as const,
          depth: 3 as const,
          children: [{ type: 'inlineCode' as const, value: 'a\nb' }],
        },
      ],
    }
    const text = stringifyMarkdownBody(root)
    expect(text).toBe('### `a\nb`')
    expect(parseMarkdownBody(text).children.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
    ])
  })

  it('survives at depth 2, where the writer falls back to a setext heading', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'heading' as const,
          depth: 2 as const,
          children: [{ type: 'inlineCode' as const, value: 'a\nb' }],
        },
      ],
    }
    const back = parseMarkdownBody(stringifyMarkdownBody(root))
    expect(back.children).toEqual(root.children)
  })
})

describe('a destination that starts with <', () => {
  // CommonMark allows `\\<` in a link destination; the writer leaves the
  // `<` raw, where the parser reads the start of a pointy-bracket
  // destination — unclosed, the construct becomes text; closed, the
  // brackets are eaten.
  it('is written raw and the parser reads it as a pointy-bracket destination', () => {
    const paragraph = (url: string) => ({
      type: 'root' as const,
      children: [
        {
          type: 'paragraph' as const,
          children: [{ type: 'image' as const, url, alt: 'x' }],
        },
      ],
    })
    const inlinesOf = (text: string) => {
      const first = parseMarkdownBody(text).children[0]
      return first?.type === 'paragraph' ? first.children : undefined
    }
    expect(stringifyMarkdownBody(paragraph('<'))).toBe('![x](<)')
    expect(inlinesOf('![x](<)')).toEqual([{ type: 'text', value: '![x](<)' }])
    expect(inlinesOf(stringifyMarkdownBody(paragraph('<a>')))).toEqual([
      { type: 'image', url: 'a', alt: 'x' },
    ])
  })

  it('survives with < anywhere but the first character', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'paragraph' as const,
          children: [{ type: 'image' as const, url: 'a<b', alt: 'x' }],
        },
      ],
    }
    const back = parseMarkdownBody(stringifyMarkdownBody(root)).children[0]
    expect(back?.type === 'paragraph' ? back.children[0] : undefined).toMatchObject({ url: 'a<b' })
  })
})

describe('a blank line inside an inline string field', () => {
  // `mdast-util-to-markdown` writes `alt` and `title` raw, so a blank line
  // inside either ends the paragraph the way it would in text. The
  // round-trip property's `hasNoBlankLineInline` excludes exactly this;
  // these pins are the fast-check counterexample that found the `alt`
  // half (seed 1557987087) and the `title` half probed beside it.
  const paragraphOf = (node: object) => ({
    type: 'root' as const,
    children: [{ type: 'paragraph' as const, children: [node] }],
  })
  const types = (root: object) =>
    parseMarkdownBody(stringifyMarkdownBody(root as never)).children.map((node) => node.type)

  it('an image alt holding a blank line is written raw and splits the paragraph', () => {
    const root = paragraphOf({ type: 'image', url: '', alt: '\n\n' })
    expect(stringifyMarkdownBody(root as never)).toBe('![\n\n]()')
    expect(types(root)).toEqual(['paragraph', 'paragraph'])
  })

  it('a link or image title holding a blank line splits the paragraph the same way', () => {
    expect(types(paragraphOf({ type: 'image', url: 'x', alt: 'a', title: 'a\n\nb' }))).toEqual([
      'paragraph',
      'paragraph',
    ])
    expect(
      types(
        paragraphOf({
          type: 'link',
          url: 'x',
          title: 'a\n\nb',
          children: [{ type: 'text', value: 'a' }],
        }),
      ),
    ).toEqual(['paragraph', 'paragraph'])
  })

  it('a single line ending in alt or title survives, so only the blank line is excluded', () => {
    const root = paragraphOf({ type: 'image', url: 'x', alt: 'a\nb', title: 'c\nd' })
    const back = parseMarkdownBody(stringifyMarkdownBody(root as never))
    expect(back.children).toEqual(root.children)
  })
})
