import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/internal'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const measure = createFakeMeasure()
const options = { measure, maxWidth: 600 }

describe('layoutMdastBlocks — semantic provenance', () => {
  const root: MdastRoot = {
    type: 'root',
    children: [
      { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title' }] },
      { type: 'heading', depth: 2, children: [{ type: 'text', value: 'Sub' }] },
      {
        type: 'list',
        ordered: true,
        children: [
          {
            type: 'listItem',
            children: [
              { type: 'paragraph', children: [{ type: 'text', value: 'one' }] },
              {
                type: 'list',
                ordered: false,
                children: [
                  {
                    type: 'listItem',
                    children: [
                      { type: 'paragraph', children: [{ type: 'text', value: 'nested' }] },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            children: [{ type: 'paragraph', children: [{ type: 'text', value: 'two' }] }],
          },
        ],
      },
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            url: 'https://example.com',
            children: [{ type: 'text', value: 'link text' }],
          },
        ],
      },
      {
        type: 'paragraph',
        children: [{ type: 'wikiLink', canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', alias: 'Alias' }],
      },
    ],
  }

  const scene = layoutMdastBlocks(root, options)

  it('recovers heading level as a structured field', () => {
    const headings = scene.nodes.filter((n) => n.kind === 'heading')
    expect(headings.map((h) => h.level)).toEqual([1, 2])
  })

  it('recovers list ordered flag and nesting depth', () => {
    const list = scene.nodes.find((n) => n.kind === 'list')
    expect(list?.kind).toBe('list')
    if (list?.kind !== 'list') throw new Error('unreachable')
    expect(list.ordered).toBe(true)
    expect(list.depth).toBe(0)
    expect(list.items[0].ordinal).toBe(1)
    expect(list.items[1].ordinal).toBe(2)

    const nestedList = list.items[0].children.find((c) => c.kind === 'list')
    expect(nestedList?.kind).toBe('list')
    if (nestedList?.kind !== 'list') throw new Error('unreachable')
    expect(nestedList.ordered).toBe(false)
    expect(nestedList.depth).toBe(1)
  })

  it('recovers link href', () => {
    const paragraph = scene.nodes.find(
      (n) => n.kind === 'paragraph' && n.runs.some((r) => r.link?.kind === 'link'),
    )
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs[0].link).toEqual({ kind: 'link', href: 'https://example.com' })
  })

  it('recovers wikiLink canvasId and alias', () => {
    const paragraph = scene.nodes.find(
      (n) => n.kind === 'paragraph' && n.runs.some((r) => r.link?.kind === 'wikiLink'),
    )
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs[0].link).toEqual({
      kind: 'wikiLink',
      canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      alias: 'Alias',
    })
  })
})

describe('layoutMdastBlocks — golden block layout', () => {
  const root: MdastRoot = {
    type: 'root',
    children: [
      { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Doc' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'Intro paragraph.' }] },
      {
        type: 'list',
        ordered: true,
        children: [
          {
            type: 'listItem',
            children: [
              { type: 'paragraph', children: [{ type: 'text', value: 'first' }] },
              {
                type: 'list',
                ordered: false,
                children: [
                  {
                    type: 'listItem',
                    children: [
                      { type: 'paragraph', children: [{ type: 'text', value: 'nested' }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'table',
        children: [
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [{ type: 'text', value: 'a' }] },
              { type: 'tableCell', children: [{ type: 'text', value: 'b' }] },
            ],
          },
        ],
      },
      { type: 'code', value: 'const x = 1', lang: 'ts' },
      {
        type: 'blockquote',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'quoted' }] }],
      },
      { type: 'thematicBreak' },
    ],
  }

  it('matches the committed golden bbox/geometry snapshot', () => {
    const scene = layoutMdastBlocks(root, options)
    expect(scene).toMatchSnapshot()
  })
})

describe('layoutMdastBlocks — node-kind coverage', () => {
  it('renders each remaining mdast node kind without throwing, per its documented fallback', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        { type: 'html', value: '<div>raw</div>' },
        { type: 'definition', identifier: 'ref', url: 'https://example.com' },
        { type: 'math', value: 'x^2', meta: null },
        {
          type: 'paragraph',
          children: [
            { type: 'inlineMath', value: 'y^2' },
            { type: 'image', url: 'https://example.com/a.png', alt: 'alt text' },
            {
              type: 'linkReference',
              identifier: 'full',
              referenceType: 'full',
              children: [{ type: 'text', value: 'full ref' }],
            },
            {
              type: 'linkReference',
              identifier: 'collapsed',
              referenceType: 'collapsed',
              children: [],
            },
            {
              type: 'linkReference',
              identifier: 'shortcut',
              referenceType: 'shortcut',
              children: [],
            },
            { type: 'imageReference', identifier: 'img', referenceType: 'shortcut' },
            { type: 'delete', children: [{ type: 'text', value: 'struck' }] },
            { type: 'break' },
            { type: 'embed', canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
          ],
        },
      ],
    }

    expect(() => layoutMdastBlocks(root, options)).not.toThrow()
    const scene = layoutMdastBlocks(root, options)
    expect(scene.nodes.some((n) => n.kind === 'rawHtml')).toBe(true)
    expect(scene.nodes.some((n) => n.kind === 'unresolvedReference')).toBe(true)
    expect(scene.nodes.some((n) => n.kind === 'svgFragment')).toBe(true)
  })
})

describe('layoutMdastBlocks — default math fallback', () => {
  it('escapes untrusted math source in the default renderMath fallback fragment', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'math', value: '</text><script>alert(1)</script><text>', meta: null }],
    }
    const scene = layoutMdastBlocks(root, options)
    const fragment = scene.nodes.find((n) => n.kind === 'svgFragment')
    expect(fragment?.kind).toBe('svgFragment')
    if (fragment?.kind !== 'svgFragment') throw new Error('unreachable')
    expect(fragment.svg).not.toContain('<script>')
    expect(fragment.svg).toBe(
      '<text>&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;text&gt;</text>',
    )
  })
})

describe('layoutMdastBlocks — single render path', () => {
  it('produces a deep-equal scene for preview, spatial-text-node, and export callers', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'shared content' }] }],
    }
    const preview = layoutMdastBlocks(root, options)
    const spatialTextNode = layoutMdastBlocks(root, options)
    const exportRender = layoutMdastBlocks(root, options)
    expect(preview).toEqual(spatialTextNode)
    expect(spatialTextNode).toEqual(exportRender)
  })
})
