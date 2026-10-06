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
})
