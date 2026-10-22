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
import { FRAGMENT_ENGINES, fragmentIsEmbeddable } from './markdown-fragment-renderers.js'

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

  // Labels are SVG text, never HTML in a <foreignObject>: an HTML label is
  // live markup in the app-origin preview and in an exported SVG.
  it('draws flowchart labels as SVG text, without a foreignObject', async () => {
    const fragment = await renderDiagramFragment('mermaid', 'graph TD; A[Alpha]-->B[Beta]')
    expect(fragment?.svg).toMatch(/<text\b[^>]*>(?:(?!<\/text>).)*Alpha/s)
    expect(fragment?.svg).not.toMatch(/<foreignObject/i)
  })

  it('draws a journey diagram, whose default text placement is HTML', async () => {
    const fragment = await renderDiagramFragment(
      'mermaid',
      'journey\ntitle t\nsection Ship\n  Build: 5: Me',
    )
    expect(fragment?.svg).toContain('Build')
    expect(fragment?.svg).not.toMatch(/<foreignObject/i)
  })

  it('keeps htmlLabels off against an init directive re-enabling them', async () => {
    const fragment = await renderDiagramFragment(
      'mermaid',
      '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\n' +
        'graph TD; A["<form action=https://evil.example><button formaction=https://evil.example>go</button></form>"]-->B',
    )
    expect(fragment?.svg).toContain('<svg')
    // Parsed rather than grepped: the label's source survives as escaped
    // TEXT, which is the safe outcome and contains the same words.
    const parsed = new DOMParser().parseFromString(fragment?.svg ?? '', 'image/svg+xml')
    expect(
      parsed.querySelectorAll('foreignObject, form, button, input, [action], [formaction]'),
    ).toHaveLength(0)
    expect(parsed.documentElement.textContent).toContain('<form action=')
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

  // A directive's `fontFamily` is written into the diagram's stylesheet with
  // only its braces balanced, so it names a font of the document's choosing
  // and can carry whole rules — `themeCSS` by another key.
  it.each([
    ['fontFamily', '{"fontFamily": "wbfontmarker"}'],
    ['fontFamily carrying a rule', '{"fontFamily": "x{} .wbfontmarker{fill:red}"}'],
    ['themeVariables fontFamily', '{"themeVariables": {"fontFamily": "wbfontmarker"}}'],
  ])('ignores a %s an init directive tries to set', async (_name, init) => {
    const fragment = await renderDiagramFragment('mermaid', `%%{init: ${init}}%%\ngraph TD; A-->B`)
    expect(fragment?.svg).toContain('<svg')
    expect(fragment?.svg).not.toContain('wbfontmarker')
  })

  it("keeps an init directive's theme colours", async () => {
    const fragment = await renderDiagramFragment(
      'mermaid',
      '%%{init: {"theme": "base", "themeVariables": {"primaryColor": "#123456"}}}%%\ngraph TD; A-->B',
    )
    expect(fragment?.svg).toContain('#123456')
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

// The fragment reaches the DOM through the HTML parser, which leaves SVG at a
// breakout tag and reads a raw-text element's body as text up to its close —
// so markup that reads as one quoted attribute to an XML reader can end in a
// live element.
describe('fragmentIsEmbeddable against the HTML parser', () => {
  const breakout = '<svg><p><textarea><x y="</textarea><img src=x onerror=alert(1)>">'
  const integrationPointStyle =
    '<svg><desc><style><x y="</style><svg onload=alert(1)>"></desc></svg>'
  // The tokenizer's other bogus-comment openers, each closed at the first `>`.
  const processingInstructionHidden = '<svg><?<g a="?><svg onload=alert(1)>"></g></svg>'
  const endTagHidden = '<svg></ <g a="> <svg onload=alert(1)>"></g></svg>'
  // A `>` or a close tag inside the integration point's own attribute value.
  const integrationPointAttributeHidden =
    '<svg><title a="> </s:title>"><style><x y="</style><svg onload=alert(1)>"></title></svg>'
  // A quote inside an unquoted value opens nothing for the HTML tokenizer,
  // which starts a quoted value only right after `=`. A scan that reads it as
  // one either never finds the tag's end or finds it past the markup.
  const unquotedValueQuote =
    '<svg><title x=a\'><style><x y="</style><svg onload=alert(1)>"></title></svg>'
  const unquotedValueQuoteLater =
    '<svg><title x=a\'><style><x y="</style><svg onload=alert(1)>"></title><g a=\'>'

  it('parses the breakout sample into a live handler', () => {
    // A template's content is inert, so the parsed <img> never loads.
    const host = document.createElement('template')
    host.innerHTML = breakout
    expect(host.content.querySelector('img[onerror]')).not.toBeNull()
  })

  it.each([
    breakout,
    '<svg><title><textarea><x y="</textarea><img src=x>"></title></svg>',
    integrationPointStyle,
    '<svg><DIV/></svg>',
    '<svg></p></svg>',
    '<svg><é:xmp/></svg>',
    '<svg><g srcdoc="x"/></svg>',
    '<svg><g DATA="x"/></svg>',
    '<svg><!--<g a="--><svg onload=alert(1)>"></g></svg>',
    '<svg><![CDATA[<g a="]]><svg onload=alert(1)>"></g></svg>',
    processingInstructionHidden,
    endTagHidden,
    '<svg></1<g a="> <svg onload=alert(1)>"></g></svg>',
    integrationPointAttributeHidden,
  ])('refuses %j', (svg) => {
    expect(fragmentIsEmbeddable(svg)).toBe(false)
  })

  it('accepts data-* attributes and element names that only start like a breakout', () => {
    expect(
      fragmentIsEmbeddable(
        '<svg><g data-id="a"><path d="M0 0"/><polygon/><text>p</text></g></svg>',
      ),
    ).toBe(true)
  })

  it('parses a style inside desc as HTML raw text', () => {
    const host = document.createElement('template')
    host.innerHTML = integrationPointStyle
    expect(host.content.querySelector('[onload]')).not.toBeNull()
  })

  it.each(
    'b big blockquote body br center code dd div dl dt em embed font h1 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var textarea xmp iframe noembed noframes noscript plaintext'.split(
      ' ',
    ),
  )('refuses a <%s> element', (name) => {
    expect(fragmentIsEmbeddable(`<svg><${name}/></svg>`)).toBe(false)
  })

  it('parses a style behind a quoted title attribute into a live handler', () => {
    const host = document.createElement('template')
    host.innerHTML = integrationPointAttributeHidden
    expect(host.content.querySelector('[onload]')).not.toBeNull()
  })

  it('parses a comment-hidden tag into a live handler', () => {
    const host = document.createElement('template')
    host.innerHTML = '<svg><!--<g a="--><svg onload=alert(1)>"></g></svg>'
    expect(host.content.querySelector('[onload]')).not.toBeNull()
  })

  it.each([
    processingInstructionHidden,
    endTagHidden,
  ])('parses a bogus-comment-hidden tag in %j into a live handler', (svg) => {
    const host = document.createElement('template')
    host.innerHTML = svg
    expect(host.content.querySelector('[onload]')).not.toBeNull()
  })

  it.each([
    ['ends nowhere for a quote-reading scan', unquotedValueQuote],
    ['ends past the markup for a quote-reading scan', unquotedValueQuoteLater],
  ])('refuses a title whose unquoted value holds a quote that %s', (_, svg) => {
    expect(fragmentIsEmbeddable(svg)).toBe(false)
  })

  it.each([
    unquotedValueQuote,
    unquotedValueQuoteLater,
  ])('parses a style behind an unquoted quote into a live handler: %j', (svg) => {
    const host = document.createElement('template')
    host.innerHTML = svg
    expect(host.content.querySelector('[onload]')).not.toBeNull()
  })

  it('refuses a fragment whose last tag never ends', () => {
    expect(fragmentIsEmbeddable('<svg><g/><title x="a')).toBe(false)
  })

  it('accepts an empty end tag, which the parser drops without a comment', () => {
    expect(fragmentIsEmbeddable('<svg><g></></g></svg>')).toBe(true)
  })

  it('accepts a title or desc holding text alone', () => {
    expect(fragmentIsEmbeddable('<svg><title>a &lt; b</title><desc>d</desc><g/></svg>')).toBe(true)
  })

  it('still embeds a real flowchart', async () => {
    const fragment = await renderDiagramFragment('mermaid', 'graph TD; A[Alpha]-->B[Beta]')
    expect(fragment?.svg).toContain('<svg')
  })
})
