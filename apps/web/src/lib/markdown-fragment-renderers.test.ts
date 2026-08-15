/**
 * Real-engine smoke for the MathJax half of the fragment renderers: the
 * dynamic-import wiring is exactly the class of failure a mocked test
 * cannot see (a subpath that resolves in dev and breaks in the production
 * bundle, or vice versa), so this renders genuine TeX through the genuine
 * engine. The mermaid half needs a real DOM and is smoked in
 * markdown-fragment-renderers.browser.test.ts instead.
 */
import { describe, expect, it } from 'vitest'
import { renderDiagramFragment, renderMathFragment } from './markdown-fragment-renderers.js'

describe('renderMathFragment (real MathJax)', () => {
  it('renders TeX to a sized SVG fragment', async () => {
    const fragment = await renderMathFragment('x^2 + y^2 = z^2', true)
    expect(fragment).toBeDefined()
    expect(fragment?.svg).toMatch(/^<svg/)
    expect(fragment?.svg).toContain('</svg>')
    expect(fragment?.width).toBeGreaterThan(0)
    expect(fragment?.height).toBeGreaterThan(0)
  })

  it('is total against TeX the engine rejects outright', async () => {
    // MathJax renders most malformed TeX as an error node rather than
    // throwing, so totality here means "resolves, never rejects".
    await expect(renderMathFragment('\\undefinedmacro{', true)).resolves.toBeDefined()
  })
})

describe('renderDiagramFragment', () => {
  it('declines every non-mermaid language without loading an engine', async () => {
    await expect(renderDiagramFragment('ts', 'const x = 1')).resolves.toBeUndefined()
  })
})
