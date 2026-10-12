import { describe, expect, it, vi } from 'vitest'
import { renderMarkdownForExport } from './document-export.js'

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

  it("draws a note's math blocks through the engine, as the preview does", async () => {
    const math = vi.fn(async () => FAKE_FRAGMENT)
    const diagram = vi.fn(async () => undefined)
    const { svg } = await renderMarkdownForExport('$$\nx^2\n$$\n', {
      fragments: { math, diagram },
    })
    expect(math).toHaveBeenCalledWith('x^2', true)
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
})
