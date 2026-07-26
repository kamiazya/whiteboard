import { describe, expect, it } from 'vitest'
import { mdastNodeSchema } from './index.js'

describe('mdastNodeSchema', () => {
  it('parses a paragraph containing text, emphasis, and strong', () => {
    const result = mdastNodeSchema.safeParse({
      type: 'paragraph',
      children: [
        { type: 'text', value: 'plain ' },
        { type: 'emphasis', children: [{ type: 'text', value: 'em' }] },
        { type: 'strong', children: [{ type: 'text', value: 'strong' }] },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('parses a heading with depth 1-6', () => {
    for (const depth of [1, 2, 3, 4, 5, 6]) {
      expect(
        mdastNodeSchema.safeParse({
          type: 'heading',
          depth,
          children: [{ type: 'text', value: 'h' }],
        }).success,
      ).toBe(true)
    }
    expect(
      mdastNodeSchema.safeParse({
        type: 'heading',
        depth: 7,
        children: [{ type: 'text', value: 'h' }],
      }).success,
    ).toBe(false)
  })

  it('parses a list containing a listItem', () => {
    const result = mdastNodeSchema.safeParse({
      type: 'list',
      ordered: false,
      children: [
        {
          type: 'listItem',
          checked: null,
          children: [{ type: 'paragraph', children: [{ type: 'text', value: 'item' }] }],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('parses a GFM table with tableRow/tableCell', () => {
    const result = mdastNodeSchema.safeParse({
      type: 'table',
      align: ['left', null, 'center'],
      children: [
        {
          type: 'tableRow',
          children: [
            { type: 'tableCell', children: [{ type: 'text', value: 'a' }] },
            { type: 'tableCell', children: [{ type: 'text', value: 'b' }] },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('parses a code node, including a mermaid diagram via lang', () => {
    // Diagrams ride the standard code node (lang: 'mermaid') — no dedicated
    // diagram node kind exists in this subset.
    const result = mdastNodeSchema.safeParse({
      type: 'code',
      lang: 'mermaid',
      value: 'graph TD; A-->B;',
    })
    expect(result.success).toBe(true)
  })

  it('parses math and inlineMath nodes', () => {
    expect(mdastNodeSchema.safeParse({ type: 'math', value: 'E = mc^2' }).success).toBe(true)
    expect(mdastNodeSchema.safeParse({ type: 'inlineMath', value: 'x^2' }).success).toBe(true)
  })

  it('parses wikiLink and embed custom nodes with a canvasId', () => {
    expect(
      mdastNodeSchema.safeParse({
        type: 'wikiLink',
        canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        alias: 'Architecture',
      }).success,
    ).toBe(true)
    expect(
      mdastNodeSchema.safeParse({ type: 'embed', canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).success,
    ).toBe(true)
  })

  it('rejects a wikiLink with a malformed canvasId', () => {
    expect(mdastNodeSchema.safeParse({ type: 'wikiLink', canvasId: 'not-a-ulid' }).success).toBe(
      false,
    )
  })

  it('rejects an unsupported node type', () => {
    expect(mdastNodeSchema.safeParse({ type: 'footnoteReference', identifier: 'x' }).success).toBe(
      false,
    )
  })

  it('parses an arbitrarily deep nesting of blockquotes without stack failure', () => {
    let node: unknown = { type: 'text', value: 'leaf' }
    for (let i = 0; i < 200; i++) {
      node = { type: 'blockquote', children: [node] }
    }
    expect(mdastNodeSchema.safeParse(node).success).toBe(true)
  })
})
