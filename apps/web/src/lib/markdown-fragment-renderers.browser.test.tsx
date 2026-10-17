/**
 * Real-engine smoke for the mermaid half of the fragment renderers —
 * mermaid needs a real DOM to measure labels, so this cannot run in
 * jsdom/node (the MathJax half is smoked in
 * markdown-fragment-renderers.test.ts). What this pins is the
 * dynamic-import wiring and the strict-security initialization, the class
 * of failure a mocked test cannot see.
 */
import { describe, expect, it } from 'vitest'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { FRAGMENT_ENGINES } from './markdown-fragment-renderers.js'

const renderDiagramFragment = FRAGMENT_ENGINES.diagram

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

  // katex is overridden across a major (pnpm-workspace.yaml) past the range
  // mermaid declares, so this pins that mermaid's `$$…$$` label path still
  // loads it and gets MathML back.
  it('renders a $$math$$ label through katex as MathML', async () => {
    const fragment = await renderDiagramFragment('mermaid', 'graph TD; A["$$x^2$$"]-->B')
    expect(fragment?.svg).toContain('<math')
    expect(fragment?.svg).toContain('<msup>')
  })

  it('is total against diagram source the engine rejects', async () => {
    const logged = expectLoggedFailures()
    await expect(
      renderDiagramFragment('mermaid', 'not a diagram at all %%%'),
    ).resolves.toBeUndefined()
    expect(logged.join('\n')).toContain('[markdown-fragments] mermaid rendering failed')
  })
})
