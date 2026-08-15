/**
 * Real-engine smoke for the mermaid half of the fragment renderers —
 * mermaid needs a real DOM to measure labels, so this cannot run in
 * jsdom/node (the MathJax half is smoked in
 * markdown-fragment-renderers.test.ts). What this pins is the
 * dynamic-import wiring and the strict-security initialization, the class
 * of failure a mocked test cannot see.
 */
import { describe, expect, it } from 'vitest'
import { renderDiagramFragment } from './markdown-fragment-renderers.js'

describe('renderDiagramFragment (real mermaid)', () => {
  it('renders a flowchart fence to a sized SVG fragment', async () => {
    const fragment = await renderDiagramFragment('mermaid', 'graph TD; A-->B; B-->C')
    expect(fragment).toBeDefined()
    expect(fragment?.svg).toContain('<svg')
    // The size must be the ROOT tag's (viewBox), not the first inner
    // element's — a three-node top-down flowchart is well over 100px tall,
    // while the inner-element bug reported a single node rect's ~30px and
    // letterboxed the whole diagram down to it.
    expect(fragment?.height).toBeGreaterThan(100)
    expect(fragment?.width).toBeGreaterThan(30)
  })

  it('is total against diagram source the engine rejects', async () => {
    await expect(
      renderDiagramFragment('mermaid', 'not a diagram at all %%%'),
    ).resolves.toBeUndefined()
  })
})
