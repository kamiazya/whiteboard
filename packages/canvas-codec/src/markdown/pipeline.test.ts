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

  it('parses an unordered list without throwing, keeping ordered false and start absent', () => {
    const root = parseMarkdownBody('- a\n- b\n')
    const list = root.children[0]
    expect(list.type).toBe('list')
    if (list.type === 'list') {
      expect(list.ordered).toBe(false)
      expect(list.start).toBeUndefined()
      expect(list.children).toHaveLength(2)
    }
  })

  it('parses an ordered list keeping its start value', () => {
    const root = parseMarkdownBody('1. a\n2. b\n')
    const list = root.children[0]
    expect(list.type).toBe('list')
    if (list.type === 'list') {
      expect(list.ordered).toBe(true)
      expect(list.start).toBe(1)
    }
  })

  it('parses a task list item keeping checked false', () => {
    const root = parseMarkdownBody('- [ ] a\n')
    const list = root.children[0]
    expect(list.type).toBe('list')
    if (list.type === 'list') {
      const [item] = list.children
      expect(item.checked).toBe(false)
    }
  })
})
