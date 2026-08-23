// `layoutMdastBlocks` lays out two surfaces with opposite needs: a 280px node
// on a canvas, and the markdown editor's preview pane at a readable measure.
// The compression that stops a heading eating a third of a node leaves the
// same heading timid on a page, so which metrics apply is the caller's to say.
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { MARKDOWN_THEME_DOCUMENT, MARKDOWN_THEME_NODE } from '../../theme/markdown-theme.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const ROOT: MdastRoot = {
  type: 'root',
  children: [
    { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title' }] },
    { type: 'paragraph', children: [{ type: 'text', value: 'prose' }] },
  ],
}
const base = { measure: createFakeMeasure(), maxWidth: 640, fontFamily: 'sans-serif' }
const headingSize = (theme?: typeof MARKDOWN_THEME_NODE) => {
  const scene = layoutMdastBlocks(ROOT, theme === undefined ? base : { ...base, theme })
  const heading = scene.nodes.find((node) => node.kind === 'heading')
  if (heading?.kind !== 'heading') throw new Error('expected a heading')
  return heading.runs[0]?.appearance?.fontSize
}

describe('the metrics a markdown body is laid out with are the caller’s choice', () => {
  it('defaults to the node scale, so every existing caller is unchanged', () => {
    expect(headingSize()).toBe(MARKDOWN_THEME_NODE.headingFontSizePx[1])
  })

  it('lays a document out larger when asked, which is the whole point', () => {
    expect(headingSize(MARKDOWN_THEME_DOCUMENT)).toBe(MARKDOWN_THEME_DOCUMENT.headingFontSizePx[1])
    expect(headingSize(MARKDOWN_THEME_DOCUMENT)).toBeGreaterThan(headingSize() ?? 0)
  })

  it('keeps h4-h6 at body size in BOTH, because neither surface may go under it', () => {
    for (const theme of [MARKDOWN_THEME_NODE, MARKDOWN_THEME_DOCUMENT]) {
      for (const level of [4, 5, 6] as const) {
        expect(theme.headingFontSizePx[level]).toBeGreaterThanOrEqual(theme.bodyFontSizePx)
      }
    }
  })

  it('carries the theme into nested blocks, not just the top level', () => {
    const nested: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'blockquote',
          children: [{ type: 'heading', depth: 1, children: [{ type: 'text', value: 'Q' }] }],
        },
      ],
    }
    const sizes = (theme: typeof MARKDOWN_THEME_NODE) => {
      const scene = layoutMdastBlocks(nested, { ...base, theme })
      const found: (number | undefined)[] = []
      const visit = (node: unknown) => {
        if (node === null || typeof node !== 'object') return
        const entry = node as {
          kind?: string
          appearance?: { fontSize?: number }
          runs?: unknown[]
          children?: unknown[]
        }
        if (entry.kind === 'textRun') found.push(entry.appearance?.fontSize)
        for (const key of ['runs', 'children'] as const) for (const c of entry[key] ?? []) visit(c)
      }
      for (const node of scene.nodes) visit(node)
      return found
    }
    expect(
      Math.max(...sizes(MARKDOWN_THEME_DOCUMENT).filter((n): n is number => n !== undefined)),
    ).toBeGreaterThan(
      Math.max(...sizes(MARKDOWN_THEME_NODE).filter((n): n is number => n !== undefined)),
    )
  })
})
