import { describe, expect, it } from 'vitest'
import {
  mdastFlowContentArbitrary,
  mdastPhrasingContentArbitrary,
  mdastRootArbitrary,
  mdastTableRowArbitrary,
} from '../test-utils/arbitraries.js'
import { fc } from '../test-utils/fast-check.js'
import { mdastFlowContentSchema, mdastNodeSchema, mdastRootSchema } from './index.js'

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

  it('parses a code node with null lang and meta, as real parsers emit for a plain fence', () => {
    const result = mdastNodeSchema.safeParse({
      type: 'code',
      lang: null,
      meta: null,
      value: 'plain fence',
    })
    expect(result.success).toBe(true)
  })

  it('parses a link and image with a null title, as real parsers emit when no title is given', () => {
    expect(
      mdastNodeSchema.safeParse({
        type: 'link',
        url: 'https://example.com',
        title: null,
        children: [{ type: 'text', value: 'link' }],
      }).success,
    ).toBe(true)
    expect(
      mdastNodeSchema.safeParse({
        type: 'image',
        url: 'https://example.com/a.png',
        title: null,
        alt: null,
      }).success,
    ).toBe(true)
  })

  it('parses a definition node', () => {
    const result = mdastNodeSchema.safeParse({
      type: 'definition',
      identifier: 'foo',
      label: 'Foo',
      url: 'https://example.com',
      title: null,
    })
    expect(result.success).toBe(true)
  })

  it('parses linkReference and imageReference nodes', () => {
    expect(
      mdastNodeSchema.safeParse({
        type: 'linkReference',
        identifier: 'foo',
        label: 'Foo',
        referenceType: 'full',
        children: [{ type: 'text', value: 'foo' }],
      }).success,
    ).toBe(true)
    expect(
      mdastNodeSchema.safeParse({
        type: 'imageReference',
        identifier: 'foo',
        label: 'Foo',
        referenceType: 'collapsed',
        alt: null,
      }).success,
    ).toBe(true)
  })

  it('parses an arbitrarily deep nesting of blockquotes without stack failure', () => {
    // blockquote children are FlowContent, so the innermost leaf must be a
    // flow node (paragraph), not a bare phrasing `text` node.
    let node: unknown = { type: 'paragraph', children: [{ type: 'text', value: 'leaf' }] }
    for (let i = 0; i < 200; i++) {
      node = { type: 'blockquote', children: [node] }
    }
    expect(mdastNodeSchema.safeParse(node).success).toBe(true)
  })

  it('parses a math node with meta:null, as mdast-util-math emits for a plain fence', () => {
    expect(mdastNodeSchema.safeParse({ type: 'math', value: 'E=mc^2', meta: null }).success).toBe(
      true,
    )
  })

  it('accepts html as both a flow child and a phrasing child (dual-category)', () => {
    expect(
      mdastRootSchema.safeParse({
        type: 'root',
        children: [{ type: 'html', value: '<div>flow</div>' }],
      }).success,
    ).toBe(true)
    expect(
      mdastFlowContentSchema.safeParse({
        type: 'paragraph',
        children: [{ type: 'html', value: '<span>inline</span>' }],
      }).success,
    ).toBe(true)
  })

  it('accepts a root document with a top-level definition', () => {
    const result = mdastRootSchema.safeParse({
      type: 'root',
      children: [
        { type: 'definition', identifier: 'foo', url: 'https://example.com' },
        { type: 'paragraph', children: [{ type: 'text', value: 'body' }] },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('still accepts a standalone structurally-valid listItem/tableRow/tableCell via mdastNodeSchema', () => {
    expect(
      mdastNodeSchema.safeParse({
        type: 'listItem',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'item' }] }],
      }).success,
    ).toBe(true)
    expect(
      mdastNodeSchema.safeParse({
        type: 'tableRow',
        children: [{ type: 'tableCell', children: [{ type: 'text', value: 'a' }] }],
      }).success,
    ).toBe(true)
    expect(
      mdastNodeSchema.safeParse({
        type: 'tableCell',
        children: [{ type: 'text', value: 'a' }],
      }).success,
    ).toBe(true)
  })
})

describe('mdast content-model placement (contextual, via parent/root schemas)', () => {
  it('rejects a root whose child is root (root never appears as a child)', () => {
    expect(
      mdastRootSchema.safeParse({
        type: 'root',
        children: [{ type: 'root', children: [] }],
      }).success,
    ).toBe(false)
  })

  it('rejects a paragraph containing root', () => {
    expect(
      mdastFlowContentSchema.safeParse({
        type: 'paragraph',
        children: [{ type: 'root', children: [] }],
      }).success,
    ).toBe(false)
  })

  it('rejects bare text directly under blockquote (blockquote children are flow-only)', () => {
    expect(
      mdastFlowContentSchema.safeParse({
        type: 'blockquote',
        children: [{ type: 'text', value: 'bare' }],
      }).success,
    ).toBe(false)
    expect(
      mdastFlowContentSchema.safeParse({
        type: 'blockquote',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'ok' }] }],
      }).success,
    ).toBe(true)
  })

  it('rejects listItem outside a list (e.g. as a blockquote child), accepts it inside a list', () => {
    expect(
      mdastFlowContentSchema.safeParse({
        type: 'blockquote',
        children: [
          {
            type: 'listItem',
            children: [{ type: 'paragraph', children: [{ type: 'text', value: 'item' }] }],
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      mdastFlowContentSchema.safeParse({
        type: 'list',
        children: [
          {
            type: 'listItem',
            children: [{ type: 'paragraph', children: [{ type: 'text', value: 'item' }] }],
          },
        ],
      }).success,
    ).toBe(true)
  })

  it('rejects tableRow outside a table (e.g. as a blockquote child), accepts it inside a table', () => {
    const tableRow = {
      type: 'tableRow',
      children: [{ type: 'tableCell', children: [{ type: 'text', value: 'a' }] }],
    }
    expect(
      mdastFlowContentSchema.safeParse({ type: 'blockquote', children: [tableRow] }).success,
    ).toBe(false)
    expect(mdastFlowContentSchema.safeParse({ type: 'table', children: [tableRow] }).success).toBe(
      true,
    )
  })

  it('rejects tableCell as a direct child of table (skipping tableRow)', () => {
    expect(
      mdastFlowContentSchema.safeParse({
        type: 'table',
        children: [{ type: 'tableCell', children: [{ type: 'text', value: 'a' }] }],
      }).success,
    ).toBe(false)
  })

  it('generates trees that cover every supported node kind (arbitrary coverage)', () => {
    const expectedKinds = new Set([
      'root',
      'paragraph',
      'heading',
      'text',
      'emphasis',
      'strong',
      'inlineCode',
      'code',
      'blockquote',
      'list',
      'listItem',
      'thematicBreak',
      'break',
      'link',
      'image',
      'html',
      'definition',
      'linkReference',
      'imageReference',
      'table',
      'tableRow',
      'tableCell',
      'delete',
      'math',
      'inlineMath',
      'wikiLink',
      'embed',
    ])

    const seenKinds = new Set<string>()
    const collect = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      if (typeof record.type === 'string') seenKinds.add(record.type)
      if (Array.isArray(record.children)) {
        for (const child of record.children) collect(child)
      }
    }

    for (const sample of fc.sample(mdastRootArbitrary(3), 300)) collect(sample)
    for (const sample of fc.sample(mdastFlowContentArbitrary(3), 300)) collect(sample)
    for (const sample of fc.sample(mdastPhrasingContentArbitrary(3), 300)) collect(sample)
    for (const sample of fc.sample(mdastTableRowArbitrary(3), 300)) collect(sample)

    const missing = [...expectedKinds].filter((kind) => !seenKinds.has(kind))
    expect(missing).toEqual([])
  })

  it('rejects break inside a tableCell, accepts break inside a paragraph', () => {
    const table = {
      type: 'table',
      children: [
        {
          type: 'tableRow',
          children: [{ type: 'tableCell', children: [{ type: 'break' }] }],
        },
      ],
    }
    expect(mdastFlowContentSchema.safeParse(table).success).toBe(false)

    expect(
      mdastFlowContentSchema.safeParse({
        type: 'paragraph',
        children: [{ type: 'text', value: 'a' }, { type: 'break' }, { type: 'text', value: 'b' }],
      }).success,
    ).toBe(true)
  })
})
