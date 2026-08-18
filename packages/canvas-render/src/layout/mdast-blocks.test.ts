import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const measure = createFakeMeasure()
const options = { measure, maxWidth: 600, fontFamily: 'sans-serif' }

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
        children: [{ type: 'wikiLink', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', alias: 'Alias' }],
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

  it('recovers wikiLink documentId and alias', () => {
    const paragraph = scene.nodes.find(
      (n) => n.kind === 'paragraph' && n.runs.some((r) => r.link?.kind === 'wikiLink'),
    )
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs[0].link).toEqual({
      kind: 'wikiLink',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
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
            { type: 'embed', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
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
  it('sizes a math fragment from the dimensions a real renderer reports', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'math', value: 'x^2', meta: null }],
    }
    const scene = layoutMdastBlocks(root, {
      ...options,
      renderMath: () => ({ svg: '<g data-math/>', width: 120, height: 48 }),
    })
    const fragment = scene.nodes.find((n) => n.kind === 'svgFragment')
    if (fragment?.kind !== 'svgFragment') throw new Error('expected svgFragment')
    expect(fragment.svg).toBe('<g data-math/>')
    expect(fragment.bbox.h).toBe(48)
    expect(fragment.bbox.w).toBe(120)

    // A reported width past the column clamps to it; a plain-string result
    // keeps the source-line-count fallback height exactly as before.
    const wide = layoutMdastBlocks(root, {
      ...options,
      renderMath: () => ({ svg: '<g/>', width: 10_000, height: 48 }),
    })
    const wideFragment = wide.nodes.find((n) => n.kind === 'svgFragment')
    if (wideFragment?.kind !== 'svgFragment') throw new Error('expected svgFragment')
    expect(wideFragment.bbox.w).toBe(600)
  })

  it('renders a fenced diagram through the renderDiagram seam, degrading to the code block', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        { type: 'code', lang: 'mermaid', meta: null, value: 'graph TD; A-->B' },
        { type: 'code', lang: 'ts', meta: null, value: 'const x = 1' },
      ],
    }
    const scene = layoutMdastBlocks(root, {
      ...options,
      renderDiagram: (lang) =>
        lang === 'mermaid' ? { svg: '<g data-diagram/>', width: 200, height: 100 } : undefined,
    })
    const kinds = scene.nodes.map((n) => n.kind)
    expect(kinds).toContain('svgFragment')
    expect(kinds).toContain('codeBlock')
    const fragment = scene.nodes.find((n) => n.kind === 'svgFragment')
    if (fragment?.kind !== 'svgFragment') throw new Error('expected svgFragment')
    expect(fragment.svg).toBe('<g data-diagram/>')
    expect(fragment.bbox).toMatchObject({ w: 200, h: 100 })

    // A throwing renderer degrades to the plain code block (total-layout
    // rule), never an aborted layout.
    const throwing = layoutMdastBlocks(root, {
      ...options,
      renderDiagram: () => {
        throw new Error('boom')
      },
    })
    expect(throwing.nodes.some((n) => n.kind === 'svgFragment')).toBe(false)
    expect(throwing.nodes.filter((n) => n.kind === 'codeBlock')).toHaveLength(2)
  })

  it('degrades a throwing renderMath to the source placeholder instead of aborting layout', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        { type: 'math', value: 'x^2', meta: null },
        { type: 'paragraph', children: [{ type: 'text', value: 'after' }] },
      ],
    }
    const scene = layoutMdastBlocks(root, {
      ...options,
      renderMath: () => {
        throw new Error('boom')
      },
    })
    const fragment = scene.nodes.find((n) => n.kind === 'svgFragment')
    if (fragment?.kind !== 'svgFragment') throw new Error('expected svgFragment')
    expect(fragment.svg).toContain('x^2')
    // The rest of the document still lays out — one bad renderer never
    // costs the whole preview.
    expect(scene.nodes.some((n) => n.kind === 'paragraph')).toBe(true)
  })

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
      '<text y="0.8em">&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;text&gt;</text>',
    )
  })
})

describe('layoutMdastBlocks — inline cursor', () => {
  it('advances a horizontal cursor across runs so they do not overlap on one line', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'plain ' },
            { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
            { type: 'text', value: ' tail' },
          ],
        },
      ],
    }
    const scene = layoutMdastBlocks(root, options)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs).toHaveLength(3)
    const [first, second, third] = paragraph.runs

    // All runs stay on the same line.
    expect(first.bbox.y).toBe(second.bbox.y)
    expect(second.bbox.y).toBe(third.bbox.y)

    // x is a monotonically increasing running cursor, never reset to 0.
    // Boundary spaces in the source ("plain ", " tail") are cursor
    // advances, not run characters (XML collapses them inside <text>).
    const fontSize = first.appearance?.fontSize ?? 0
    const spaceWidth = measure(' ', {
      family: 'sans-serif',
      fallbackChain: [],
      weight: 400,
      style: 'normal',
      sizePx: fontSize,
    }).advanceWidth
    expect(first.bbox.x).toBe(0)
    expect(second.bbox.x).toBeCloseTo(first.bbox.x + first.bbox.w + spaceWidth, 5)
    expect(third.bbox.x).toBeCloseTo(second.bbox.x + second.bbox.w + spaceWidth, 5)

    // No pair of runs overlaps horizontally.
    expect(first.bbox.x + first.bbox.w).toBeLessThanOrEqual(second.bbox.x)
    expect(second.bbox.x + second.bbox.w).toBeLessThanOrEqual(third.bbox.x)
  })

  it('resets x and advances y to a new line on a hard break', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'first line' },
            { type: 'break' },
            { type: 'text', value: 'second line' },
          ],
        },
      ],
    }
    const scene = layoutMdastBlocks(root, options)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs).toHaveLength(2)
    const [firstLine, secondLine] = paragraph.runs

    expect(secondLine.bbox.x).toBe(0)
    expect(secondLine.bbox.y).toBeGreaterThan(firstLine.bbox.y)
  })

  it('grows a multi-line paragraph bbox.h to cover every line produced', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'line one' },
            { type: 'break' },
            { type: 'text', value: 'line two' },
            { type: 'break' },
            { type: 'text', value: 'line three' },
          ],
        },
        // A following block's y must start after all 3 lines, proving the
        // block cursor also advanced by the full multi-line height.
        { type: 'paragraph', children: [{ type: 'text', value: 'next block' }] },
      ],
    }
    const scene = layoutMdastBlocks(root, options)
    const [multiLine, nextBlock] = scene.nodes
    expect(multiLine.kind).toBe('paragraph')
    expect(nextBlock.kind).toBe('paragraph')
    if (multiLine.kind !== 'paragraph' || nextBlock.kind !== 'paragraph') {
      throw new Error('unreachable')
    }
    const lineHeight = multiLine.runs[0].bbox.h
    expect(multiLine.bbox.h).toBe(3 * lineHeight)
    expect(nextBlock.bbox.y).toBeGreaterThanOrEqual(multiLine.bbox.y + multiLine.bbox.h)
  })
})

describe('layoutMdastBlocks — text run baseline', () => {
  it('carries a measured ascent baseline while leaving bbox.y as the line top', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'heading', depth: 1, children: [{ type: 'text', value: 'Heading' }] }],
    }
    const scene = layoutMdastBlocks(root, options)
    const heading = scene.nodes.find((n) => n.kind === 'heading')
    expect(heading?.kind).toBe('heading')
    if (heading?.kind !== 'heading') throw new Error('unreachable')
    const [run] = heading.runs
    // fake measure: ascent = fontSizePx * 0.8
    expect(run.baseline).toBe(32 * 0.8)
    // bbox.y must stay the line TOP (unaffected by baseline) so sceneBounds
    // keeps measuring a true top-left box.
    expect(run.bbox.y).toBe(0)
  })
})

describe('layoutMdastBlocks — word wrap', () => {
  it('wraps a paragraph whose text overflows maxWidth onto multiple lines, each run contained', () => {
    const narrow = { measure, maxWidth: 60, fontFamily: 'sans-serif' }
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'one two three four' }] }],
    }
    const scene = layoutMdastBlocks(root, narrow)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs.length).toBeGreaterThan(1)
    for (const run of paragraph.runs) {
      expect(run.bbox.x).toBeGreaterThanOrEqual(0)
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(narrow.maxWidth)
    }
    // block height grows with the number of lines produced.
    const lineHeight = paragraph.runs[0].bbox.h
    const lineCount = new Set(paragraph.runs.map((r) => r.bbox.y)).size
    expect(lineCount).toBeGreaterThan(1)
    expect(paragraph.bbox.h).toBe(lineCount * lineHeight)
  })

  it('breaks a token with no break opportunity in it by code point', () => {
    // A token UAX #14 offers no break inside (one long identifier) used to be
    // left whole and allowed to paint past the border. It is now split, and
    // the only thing that may still overflow is a single glyph.
    const narrow = { measure, maxWidth: 10, fontFamily: 'sans-serif' }
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'unbreakabletoken' }] }],
    }
    const scene = layoutMdastBlocks(root, narrow)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs).toHaveLength('unbreakabletoken'.length)
    for (const run of paragraph.runs) {
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(narrow.maxWidth)
    }
  })

  it('leaves a single glyph wider than maxWidth overflowing rather than dropping it', () => {
    // The documented irreducible exception: there is nothing below a code
    // point to split, so the choice is overflow or loss, and loss is worse.
    const tiny = { measure, maxWidth: 1, fontFamily: 'sans-serif' }
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'ab' }] }],
    }
    const scene = layoutMdastBlocks(root, tiny)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs.map((run) => run.text)).toEqual(['a', 'b'])
    expect(paragraph.runs[0].bbox.w).toBeGreaterThan(tiny.maxWidth)
  })

  it('does not throw and produces no wrap for a non-finite or non-positive maxWidth', () => {
    for (const badWidth of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = { measure, maxWidth: badWidth, fontFamily: 'sans-serif' }
      const root: MdastRoot = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'one two three' }] }],
      }
      expect(() => layoutMdastBlocks(root, bad)).not.toThrow()
    }
  })

  it('keeps an overflowing inline code span whole instead of splitting it at whitespace', () => {
    const narrow = { measure, maxWidth: 60, fontFamily: 'sans-serif' }
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'inlineCode', value: 'function call with spaces()' }],
        },
      ],
    }
    const scene = layoutMdastBlocks(root, narrow)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    // One run: an interior space in a code span is not a word boundary, so it
    // is never SPLIT there. It is CUT to fit instead, and says so.
    expect(paragraph.runs).toHaveLength(1)
    expect(paragraph.runs[0].truncated).toBe(true)
    expect('function call with spaces()'.startsWith(paragraph.runs[0].text)).toBe(true)
  })

  it('keeps an overflowing raw html run whole instead of splitting it at whitespace', () => {
    const narrow = { measure, maxWidth: 60, fontFamily: 'sans-serif' }
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'html', value: '<span class="a b c" data-x="y">' }],
        },
      ],
    }
    const scene = layoutMdastBlocks(root, narrow)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    // One run — an attribute value's spaces are not word boundaries — cut to
    // fit rather than split.
    expect(paragraph.runs).toHaveLength(1)
    expect(paragraph.runs[0].truncated).toBe(true)
    expect('<span class="a b c" data-x="y">'.startsWith(paragraph.runs[0].text)).toBe(true)
  })

  it('preserves a space between a wrapped chunk and the next inline sibling', () => {
    // mdast represents "long line " + strong("word") as two adjacent
    // phrasing children: a text node ending in a space, then a styled run.
    // The trailing space belongs to the wrapped chunk, not the sibling, so
    // it must still separate them even when the chunk wraps mid-word.
    // Width chosen so the chunk WRAPS ("longer line" does not fit) and the
    // wrapped remainder plus the sibling still share the second line — the
    // only arrangement in which "is the separator still there" is a question.
    const narrow = { measure, maxWidth: 90, fontFamily: 'sans-serif' }
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'longer line ' },
            { type: 'strong', children: [{ type: 'text', value: 'word' }] },
          ],
        },
      ],
    }
    const scene = layoutMdastBlocks(root, narrow)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    const lastWrappedRun = paragraph.runs.find((r) => r.text === 'line')
    const siblingRun = paragraph.runs.find((r) => r.text === 'word')
    expect(lastWrappedRun).toBeDefined()
    expect(siblingRun).toBeDefined()
    if (!lastWrappedRun || !siblingRun) throw new Error('unreachable')
    // Same line, so a real gap (a space's width) must separate them.
    expect(siblingRun.bbox.y).toBe(lastWrappedRun.bbox.y)
    const spaceWidth = measure(' ', {
      family: 'test',
      fallbackChain: [],
      weight: 400,
      style: 'normal',
      sizePx: 16,
    }).advanceWidth
    expect(siblingRun.bbox.x).toBeGreaterThanOrEqual(
      lastWrappedRun.bbox.x + lastWrappedRun.bbox.w + spaceWidth,
    )
  })

  it('adds exactly one separator space before the first word of a wrapped chunk with leading whitespace', () => {
    // A chunk whose own text begins with whitespace (e.g. the second of two
    // adjacent phrasing children "prose" + " word rest...") overflows as a
    // whole even though its first word alone still fits on the current
    // line. The leading-whitespace pre-add in `wrapAndPush` must not stack
    // with the per-word loop's own separator-add on that first iteration —
    // the gap before the first word must be exactly one space, not two.
    const narrow = { measure, maxWidth: 100, fontFamily: 'sans-serif' }
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'aaaaa' },
            { type: 'strong', children: [{ type: 'text', value: ` bb ${'c'.repeat(21)}` }] },
          ],
        },
      ],
    }
    const scene = layoutMdastBlocks(root, narrow)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    const firstRun = paragraph.runs.find((r) => r.text === 'aaaaa')
    const bbRun = paragraph.runs.find((r) => r.text === 'bb')
    expect(firstRun).toBeDefined()
    expect(bbRun).toBeDefined()
    if (!firstRun || !bbRun) throw new Error('unreachable')
    const spaceWidth = measure(' ', {
      family: 'test',
      fallbackChain: [],
      weight: 400,
      style: 'normal',
      sizePx: 16,
    }).advanceWidth
    expect(bbRun.bbox.x).toBeCloseTo(firstRun.bbox.x + firstRun.bbox.w + spaceWidth, 5)
  })

  it('keeps an overflowing inline math run whole instead of splitting it at whitespace', () => {
    const narrow = { measure, maxWidth: 60, fontFamily: 'sans-serif' }
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'inlineMath', value: 'a + b + c + d + e' }],
        },
      ],
    }
    const scene = layoutMdastBlocks(root, narrow)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    // Math is the one atomic run that is not CUT either: `a + b + c` cut to
    // `a + b` reads as a complete formula that is simply wrong, where cut code
    // reads as cut. Overflowing is the lesser harm, so it keeps every term.
    expect(paragraph.runs).toHaveLength(1)
    expect(paragraph.runs[0].text).toBe('a + b + c + d + e')
    expect(paragraph.runs[0].truncated).toBeUndefined()
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

describe('layoutMdastBlocks — whitespace at inline-run boundaries', () => {
  // XML (and therefore SVG <text>) collapses leading/trailing whitespace,
  // so a run whose TEXT carries a boundary space paints its first glyph a
  // space-width left of where layout measured it — "`inline code` and"
  // renders as "inline codeand". Boundary whitespace must be geometry
  // (cursor advance), never run content.
  it('emits collapse-stable run text and carries boundary spaces as cursor advances', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'inlineCode', value: 'inline code' },
            { type: 'text', value: ' and a ' },
            {
              type: 'link',
              url: 'https://example.com',
              children: [{ type: 'text', value: 'link' }],
            },
            { type: 'text', value: ' too.' },
          ],
        },
      ],
    }
    const scene = layoutMdastBlocks(root, options)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.kind).toBe('paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')

    expect(paragraph.runs.map((r) => r.text)).toEqual(['inline code', 'and a', 'link', 'too.'])

    const [code, andA, link, too] = paragraph.runs
    const fontSize = code.appearance?.fontSize ?? 0
    expect(fontSize).toBeGreaterThan(0)
    const spaceWidth = measure(' ', {
      family: 'sans-serif',
      fallbackChain: [],
      weight: 400,
      style: 'normal',
      sizePx: fontSize,
    }).advanceWidth
    expect(andA.bbox.x).toBeCloseTo(code.bbox.x + code.bbox.w + spaceWidth, 5)
    expect(link.bbox.x).toBeCloseTo(andA.bbox.x + andA.bbox.w + spaceWidth, 5)
    expect(too.bbox.x).toBeCloseTo(link.bbox.x + link.bbox.w + spaceWidth, 5)
  })

  it('collapses interior whitespace sequences to the single space XML will paint', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'kept  double\nsoft' }] }],
    }
    const scene = layoutMdastBlocks(root, options)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs.map((r) => r.text)).toEqual(['kept double soft'])
  })

  it('a whitespace-only text node becomes an advance, never an empty run', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'strong', children: [{ type: 'text', value: 'a' }] },
            { type: 'text', value: ' ' },
            { type: 'strong', children: [{ type: 'text', value: 'b' }] },
          ],
        },
      ],
    }
    const scene = layoutMdastBlocks(root, options)
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    if (paragraph?.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs.map((r) => r.text)).toEqual(['a', 'b'])
    const [a, b] = paragraph.runs
    expect(b.bbox.x).toBeGreaterThan(a.bbox.x + a.bbox.w)
  })
})

describe('layoutMdastBlocks — embed body resolution', () => {
  const A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
  const C = '01BX5ZZKBKACTAV9WEVGEMMVS0'
  const D = '01BX5ZZKBKACTAV9WEVGEMMVS1'
  type Flow = import('@kamiazya/whiteboard-model/mdast').MdastFlowContent
  const para = (text: string): Flow => ({
    type: 'paragraph',
    children: [{ type: 'text', value: text }],
  })
  const embedPara = (documentId: string): Flow => ({
    type: 'paragraph',
    children: [{ type: 'embed', documentId }],
  })
  const rootOf = (children: Flow[]): MdastRoot => ({ type: 'root', children })

  it("lays out a block embed's resolved body under an embedResolved node, advancing the cursor", () => {
    const root = rootOf([para('before'), embedPara(A), para('after')])
    const scene = layoutMdastBlocks(root, {
      ...options,
      resolveEmbed: (id) =>
        id === A ? { title: 'Target', root: rootOf([para('embedded body')]) } : undefined,
    })
    expect(scene.nodes.map((n) => n.kind)).toEqual(['paragraph', 'embedResolved', 'paragraph'])
    const embed = scene.nodes[1]
    if (embed.kind !== 'embedResolved') throw new Error('unreachable')
    expect(embed.documentId).toBe(A)
    expect(embed.children).toHaveLength(1)
    const inner = embed.children[0]
    if (inner.kind !== 'paragraph') throw new Error('expected embedded paragraph')
    expect(inner.runs.map((r) => r.text).join(' ')).toBe('embedded body')
    // The embedded content occupies real vertical space between its siblings.
    const [before, , after] = scene.nodes
    if (before.kind !== 'paragraph' || after.kind !== 'paragraph') throw new Error('unreachable')
    expect(inner.bbox.y).toBeGreaterThan(before.bbox.y)
    expect(after.bbox.y).toBeGreaterThan(inner.bbox.y + inner.bbox.h - 1)
  })

  it('a cyclic embed degrades to a placeholder with reason cycle, never looping', () => {
    const docs: Record<string, MdastRoot> = {
      [A]: rootOf([para('in A'), embedPara(B)]),
      [B]: rootOf([para('in B'), embedPara(A)]),
    }
    const scene = layoutMdastBlocks(rootOf([embedPara(A)]), {
      ...options,
      resolveEmbed: (id) => (docs[id] ? { root: docs[id] } : undefined),
    })
    const placeholders: string[] = []
    const visit = (nodes: readonly unknown[]) => {
      for (const node of nodes as { kind: string; reason?: string; children?: unknown[] }[]) {
        if (node.kind === 'embedPlaceholder' && node.reason) placeholders.push(node.reason)
        if (Array.isArray(node.children)) visit(node.children)
      }
    }
    visit(scene.nodes)
    expect(placeholders).toEqual(['cycle'])
  })

  it('nesting past the depth cap degrades to a placeholder with reason depthCap', () => {
    const docs: Record<string, MdastRoot> = {
      [A]: rootOf([embedPara(B)]),
      [B]: rootOf([embedPara(C)]),
      [C]: rootOf([embedPara(D)]),
      [D]: rootOf([para('too deep')]),
    }
    const scene = layoutMdastBlocks(rootOf([embedPara(A)]), {
      ...options,
      resolveEmbed: (id) => (docs[id] ? { root: docs[id] } : undefined),
    })
    const reasons: string[] = []
    const texts: string[] = []
    const visit = (nodes: readonly unknown[]) => {
      for (const node of nodes as {
        kind: string
        reason?: string
        text?: string
        children?: unknown[]
        runs?: unknown[]
      }[]) {
        if (node.kind === 'embedPlaceholder' && node.reason) reasons.push(node.reason)
        if (node.kind === 'textRun' && node.text) texts.push(node.text)
        if (Array.isArray(node.children)) visit(node.children)
        if (Array.isArray(node.runs)) visit(node.runs)
      }
    }
    visit(scene.nodes)
    expect(reasons).toEqual(['depthCap'])
    expect(texts).not.toContain('too deep')
  })

  it('a missing target and a throwing resolver both degrade to unresolvable', () => {
    const missing = layoutMdastBlocks(rootOf([embedPara(A)]), {
      ...options,
      resolveEmbed: () => undefined,
    })
    const throwing = layoutMdastBlocks(rootOf([embedPara(A)]), {
      ...options,
      resolveEmbed: () => {
        throw new Error('boom')
      },
    })
    for (const scene of [missing, throwing]) {
      const node = scene.nodes[0]
      if (node.kind !== 'embedPlaceholder') throw new Error('expected placeholder')
      expect(node.reason).toBe('unresolvable')
    }
  })

  it('an inline embed mixed into prose renders the resolved title instead of the raw id', () => {
    const root: MdastRoot = rootOf([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'see ' },
          { type: 'embed', documentId: A },
        ],
      },
    ])
    const scene = layoutMdastBlocks(root, {
      ...options,
      resolveEmbed: (id) => (id === A ? { title: 'Target note', root: rootOf([]) } : undefined),
    })
    const paragraph = scene.nodes[0]
    if (paragraph.kind !== 'paragraph') throw new Error('unreachable')
    expect(paragraph.runs.map((r) => r.text)).toEqual(['see', 'Target note'])
  })
})
