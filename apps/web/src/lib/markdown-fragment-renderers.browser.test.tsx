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

  it('is total against diagram source the engine rejects', async () => {
    const logged = expectLoggedFailures()
    await expect(
      renderDiagramFragment('mermaid', 'not a diagram at all %%%'),
    ).resolves.toBeUndefined()
    expect(logged.join('\n')).toContain('[markdown-fragments] mermaid rendering failed')
  })

  it('ignores a themeCSS an init directive tries to inject', async () => {
    const marker = 'wbinjectedcssmarker'
    const fragment = await renderDiagramFragment(
      'mermaid',
      `%%{init: {"themeCSS": ".${marker} { fill: red; }"}}%%\ngraph TD; A-->B`,
    )
    expect(fragment?.svg).toContain('<svg')
    expect(fragment?.svg).not.toContain(marker)
  })

  it('ignores a dompurifyConfig an init directive tries to loosen', async () => {
    const fragment = await renderDiagramFragment(
      'mermaid',
      '%%{init: {"dompurifyConfig": {"ADD_ATTR": ["onclick"]}}}%%\ngraph TD; A["<b onclick=x>hi</b>"]-->B',
    )
    expect(fragment?.svg).toContain('<svg')
    expect(fragment?.svg).not.toMatch(/onclick/i)
  })
})
