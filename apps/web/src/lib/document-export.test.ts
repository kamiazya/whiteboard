import { referenceSeams } from '@kamiazya/whiteboard-canvas-render'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { renderMarkdownForExport } from './document-export.js'

const NOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const FAKE_FRAGMENT = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="10"><path data-probe="fragment-drawn" d="M0 0h40"/></svg>',
  width: 40,
  height: 10,
}

describe('renderMarkdownForExport', () => {
  it('draws a markdown note from its body, sized by what it holds', async () => {
    const { svg, bounds } = await renderMarkdownForExport('# Exportedheading\n\nSome prose.\n')
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
    expect(root.textContent).toContain('Exportedheading')
    expect(bounds.w).toBeGreaterThan(1)
    expect(bounds.h).toBeGreaterThan(1)
  })

  it('fills the note with the paper first when asked, and draws the same bytes otherwise', async () => {
    const plain = await renderMarkdownForExport('# Heading\n\nProse.\n')
    const paper = await renderMarkdownForExport('# Heading\n\nProse.\n', {
      picture: { scale: 1, background: true },
    })
    expect(paper.scale).toBe(1)
    expect(plain.scale).toBeUndefined()
    const { x, y, w, h } = paper.bounds
    const body = paper.svg.slice(paper.svg.indexOf('>') + 1)
    expect(
      body.startsWith(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"`),
    ).toBe(true)
    expect(plain.svg).not.toContain('role="presentation"')
    expect(paper.svg.replace(/<rect[^>]*role="presentation"[^>]*\/>/, '')).toBe(plain.svg)
  })

  it("draws a note's math blocks through the engine, as the preview does", async () => {
    const math = vi.fn(async () => FAKE_FRAGMENT)
    const diagram = vi.fn(async () => undefined)
    const { svg } = await renderMarkdownForExport('$$\nx^2\n$$\n', {
      fragments: { math, diagram },
    })
    expect(math).toHaveBeenCalledWith('x^2')
    expect(svg).toContain('fragment-drawn')
  })

  it("draws a note's diagram fences through the engine, keeping the fallback where one fails", async () => {
    const math = vi.fn(async () => undefined)
    const diagram = vi.fn(async (_lang: string, value: string) => {
      if (value.includes('broken')) throw new Error('engine failed')
      return FAKE_FRAGMENT
    })
    const { svg } = await renderMarkdownForExport(
      '```mermaid\ngraph TD; A-->B\n```\n\n```mermaid\nbroken\n```\n',
      { fragments: { math, diagram } },
    )
    expect(diagram).toHaveBeenCalledWith('mermaid', 'graph TD; A-->B')
    expect(diagram).toHaveBeenCalledWith('mermaid', 'broken')
    expect(svg.match(/fragment-drawn/g)).toHaveLength(1)
    // The failed fence still draws, as its source.
    expect(
      new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement.textContent,
    ).toContain('broken')
  })

  it('draws an embedded note through the references it is handed', async () => {
    const { svg } = await renderMarkdownForExport(`before\n\n![[${NOTE_ID}]]\n\nafter`, {
      references: referenceSeams(new Map([[NOTE_ID, { name: 'Target', body: 'embedded body' }]])),
    })
    expect(svg).toContain('embedded body')
  })

  it('wraps at the width the daemon draws a note at', async () => {
    const long = Array.from({ length: 200 }, () => 'word').join(' ')
    const { bounds } = await renderMarkdownForExport(long)
    expect(bounds.w).toBeGreaterThan(1)
    expect(bounds.w).toBeLessThanOrEqual(720)
  })

  it('colours an embedded board by the tag library, in the light theme', async () => {
    const { svg } = await renderMarkdownForExport(`![[${NOTE_ID}]]\n`, {
      tagLibrary: { health: { exclusive: true, values: { failing: { color: '1' } } } },
      references: referenceSeams(
        new Map([
          [
            NOTE_ID,
            {
              name: 'The Board',
              canvas: {
                nodes: [
                  textNode({
                    id: 'db',
                    x: 0,
                    y: 0,
                    width: 300,
                    height: 120,
                    text: 'db',
                    tags: ['health:failing'],
                  }),
                ],
                edges: [],
              },
            },
          ],
        ]),
      ),
    })
    // Preset 1's LIGHT fill: the declared colour, in the theme a saved file is pinned to.
    expect(svg).toContain('#fee2e2')
  })
})
