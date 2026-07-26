import { describe, expect, it } from 'vitest'
import { parseMarkdownBody, stringifyMarkdownBody } from './pipeline.js'

describe('markdown pipeline pinned examples', () => {
  it('keeps a ```mermaid fence a code node with lang "mermaid"', () => {
    const root = parseMarkdownBody('```mermaid\ngraph TD;\nA-->B;\n```\n')
    expect(root.children[0]).toMatchObject({ type: 'code', lang: 'mermaid' })
  })

  it('parses a GFM table', () => {
    const root = parseMarkdownBody('| a | b |\n| - | - |\n| 1 | 2 |\n')
    expect(root.children[0].type).toBe('table')
  })

  it('parses inline math ($..$) and block math ($$..$$)', () => {
    const inline = parseMarkdownBody('this is $x^2$ inline\n')
    const paragraph = inline.children[0]
    expect(paragraph.type).toBe('paragraph')
    if (paragraph.type === 'paragraph') {
      expect(paragraph.children.some((child) => child.type === 'inlineMath')).toBe(true)
    }

    const block = parseMarkdownBody('$$\nx^2\n$$\n')
    expect(block.children[0].type).toBe('math')
  })

  it('parses a simple paragraph and stringifies it back to equivalent markdown', () => {
    const root = parseMarkdownBody('Hello **world**.\n')
    const text = stringifyMarkdownBody(root)
    expect(text).toContain('Hello')
    expect(text).toContain('world')
  })
})
