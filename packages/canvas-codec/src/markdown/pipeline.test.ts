import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { describe, expect, it } from 'vitest'
import { normalizeMdast } from './normalize.js'
import { parseMarkdownBlockLines, parseMarkdownBody, stringifyMarkdownBody } from './pipeline.js'

describe('markdown pipeline pinned examples', () => {
  // fast-check counterexample (seed 1010669059, shrunk 17x) from the
  // round-trip property: a link with `$` in its url adjacent to `]` in its
  // text. mdast-util-math registers a toMarkdown `unsafe` pattern for `$`
  // with an `after: undefined` key; mdast-util-to-markdown's `safe()` reads
  // that as `'after' in pattern`, so it thinks an "after" constraint is
  // present, matches it against undefined, and skips escaping the `$` that
  // sits right before the link text's own escaped `]`. The unescaped `$]`
  // then re-parses as a shorter link, changing the tree shape.
  it('round-trips a link whose text ends in "$]" next to a "$"-terminated url', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'heading',
          depth: 1,
          children: [
            {
              type: 'link',
              url: 'http://a.aa/$',
              title: null,
              children: [{ type: 'text', value: '$]' }],
            },
          ],
        },
        { type: 'thematicBreak' },
      ],
    }
    const text = stringifyMarkdownBody(root)
    expect(text).toContain('[\\$\\]]')
    const reparsed = parseMarkdownBody(text)
    expect(normalizeMdast(reparsed)).toEqual(normalizeMdast(root))
  })

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

describe('parseMarkdownBlockLines', () => {
  it('reports the 1-based start line of each top-level block, index-aligned with parseMarkdownBody', () => {
    const body =
      '# Title\n\npara one\nstill para one\n\n```ts\nconst x = 1\nconst y = 2\n```\n\n- item\n'
    const lines = parseMarkdownBlockLines(body)
    const root = parseMarkdownBody(body)
    expect(lines).toHaveLength(root.children.length)
    expect(lines).toEqual([1, 3, 6, 11])
  })

  it('is total: an empty body maps to no blocks', () => {
    expect(parseMarkdownBlockLines('')).toEqual([])
  })
})
